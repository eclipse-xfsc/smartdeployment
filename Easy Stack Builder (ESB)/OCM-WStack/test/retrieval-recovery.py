import copy
import datetime
import hashlib
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/retrieval-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
CQL = (ROOT / 'scripts/retrieval-v001.cql').read_text()
SUM = hashlib.sha256(CQL.encode()).hexdigest()
NOW = datetime.datetime(2026, 10, 4, 12, 0, tzinfo=datetime.timezone.utc)


class Database:
    def __init__(self):
        self.history = True
        self.rows = [dict(version=1, name='create offerings table', checksum=SUM,
                          applied_at=NOW.replace(tzinfo=None) - datetime.timedelta(minutes=10), dirty=True)]
        self.exists = False
        self.columns = copy.deepcopy(recovery.EXPECTED_COLUMNS)
        self.ttl = 17800
        self.writes = []
        self.race = False
        self.create_error = False

    def query(self, query, params=None):
        if "table_name='retrieval_schema_migration'" in query:
            return [{'table_name': recovery.TABLE}] if self.history else []
        if query.startswith('SELECT version'):
            return copy.deepcopy(self.rows)
        if query.startswith('SELECT default_time_to_live'):
            return [{'default_time_to_live': self.ttl}] if self.exists else []
        if query.startswith('SELECT column_name'):
            return [dict(column_name=k, type=v[0], kind=v[1], position=v[2]) for k, v in self.columns.items()]
        if query == CQL:
            if self.create_error:
                raise RuntimeError('schema agreement timeout')
            self.writes.append(query)
            self.exists = True
            return []
        if query.startswith('UPDATE ocm.retrieval_schema_migration'):
            self.writes.append(query)
            if self.race:
                return [{'[applied]': False}]
            assert params[1:] == (self.rows[0]['checksum'], self.rows[0]['name'], self.rows[0]['applied_at'])
            self.rows[0].update(dirty=False, applied_at=params[0])
            return [{'[applied]': True}]
        raise AssertionError(query)


class RecoveryTests(unittest.TestCase):
    def config(self, mode='inspect', expected=None):
        return dict(cql=CQL, checksum=SUM, mode=mode, expected=expected)

    def run_repair(self, db):
        inspection = recovery.recover(db, self.config(), NOW)
        self.assertEqual(db.writes, [])
        return recovery.recover(db, self.config('repair', inspection['before']), NOW)

    def test_absent_table_replays_exact_native_migration_then_cleans(self):
        db = Database()
        result = self.run_repair(db)
        self.assertEqual(result['state'], 'repaired')
        self.assertEqual(db.writes[0], CQL)
        self.assertTrue(result['before']['dirty'])
        self.assertFalse(result['after']['dirty'])
        self.assertEqual(recovery.recover(db, self.config(), NOW)['state'], 'not-needed')
        self.assertEqual(len(db.writes), 2)

    def test_existing_exact_table_preserved(self):
        db = Database()
        db.exists = True
        self.assertEqual(self.run_repair(db)['schema']['columns'], 11)
        self.assertTrue(all('DROP ' not in q and 'TRUNCATE ' not in q and 'ALTER ' not in q for q in db.writes))

    def test_new_database_and_clean_migration_are_read_only(self):
        db = Database()
        db.history = False
        self.assertEqual(recovery.recover(db, self.config(), NOW)['state'], 'not-needed')
        db.history = True
        db.rows[0]['dirty'] = False
        self.assertEqual(recovery.recover(db, self.config(), NOW)['state'], 'not-needed')
        self.assertEqual(db.writes, [])

    def test_recent_migration_is_not_touched(self):
        db = Database()
        db.rows[0]['applied_at'] = NOW.replace(tzinfo=None) - datetime.timedelta(seconds=100)
        self.assertEqual(recovery.recover(db, self.config(), NOW)['state'], 'settling')
        self.assertEqual(db.writes, [])

    def test_checksum_unknown_history_and_schema_mismatches_refused(self):
        for case in ['checksum', 'history', 'column', 'primary-key', 'ttl']:
            with self.subTest(case=case):
                db = Database()
                db.exists = True
                if case == 'checksum': db.rows[0]['checksum'] = 'wrong'
                if case == 'history': db.rows.append(dict(db.rows[0], version=2))
                if case == 'column': db.columns['metadata'] = ('blob', 'regular', -1)
                if case == 'primary-key': db.columns['groupid'] = ('text', 'partition_key', 4)
                if case == 'ttl': db.ttl = 0
                with self.assertRaises(recovery.RecoveryError):
                    recovery.recover(db, self.config(), NOW)
                self.assertEqual(db.writes, [])

    def test_changed_inspection_refused_before_replay(self):
        db = Database()
        before = recovery.recover(db, self.config(), NOW)['before']
        db.rows[0]['applied_at'] -= datetime.timedelta(seconds=1)
        with self.assertRaisesRegex(recovery.RecoveryError, 'CHANGED'):
            recovery.recover(db, self.config('repair', before), NOW)
        self.assertEqual(db.writes, [])

    def test_failed_native_ddl_does_not_clear_dirty_flag(self):
        db = Database()
        db.create_error = True
        with self.assertRaises(RuntimeError): self.run_repair(db)
        self.assertTrue(db.rows[0]['dirty'])
        self.assertEqual(db.writes, [])

    def test_concurrent_change_does_not_force_clean(self):
        db = Database()
        db.race = True
        with self.assertRaisesRegex(recovery.RecoveryError, 'CHANGED'): self.run_repair(db)
        self.assertTrue(db.rows[0]['dirty'])

    def test_wrong_packaged_migration_cannot_run(self):
        db = Database()
        config = self.config()
        config['cql'] += '\n'
        with self.assertRaisesRegex(recovery.RecoveryError, 'CHECKSUM'):
            recovery.recover(db, config, NOW)
        self.assertEqual(db.writes, [])


if __name__ == '__main__': unittest.main()
