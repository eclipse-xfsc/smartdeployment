"""Guarded recovery of the official Retrieval 1.1.5 V001 migration.

Executed via kubectl exec in the existing Cassandra container. Uses that image's
bundled Python driver; no service binary, driver or database is shipped by ESB.
Input (including credentials) arrives only on stdin. Output contains no rows of
offers/credentials and no authentication material.
"""
import datetime
import hashlib
import json
import pathlib
import runpy
import shutil
import sys

TABLE = 'retrieval_schema_migration'
EXPECTED_COLUMNS = {
    'partition': ('text', 'partition_key', 0),
    'region': ('text', 'partition_key', 1),
    'country': ('text', 'partition_key', 2),
    'tenantid': ('text', 'partition_key', 3),
    'groupid': ('text', 'clustering', 0),
    'requestid': ('text', 'clustering', 1),
    **{k: ('text', 'regular', -1) for k in
       ['type', 'metadata', 'offerparams', 'status']},
    'last_update_timestamp': ('timestamp', 'regular', -1),
}


class RecoveryError(Exception):
    pass


def snapshot(row):
    return {**row, 'applied_at': row['applied_at'].isoformat()}


def schema(db):
    tables = db.query("SELECT default_time_to_live FROM system_schema.tables "
                      "WHERE keyspace_name='ocm' AND table_name='offerings'")
    if not tables:
        return None
    columns = db.query("SELECT column_name, type, kind, position FROM system_schema.columns "
                       "WHERE keyspace_name='ocm' AND table_name='offerings'")
    actual = {r['column_name']: (r['type'], r['kind'], r['position']) for r in columns}
    if actual != EXPECTED_COLUMNS or tables[0]['default_time_to_live'] != 17800:
        raise RecoveryError('RETRIEVAL_SCHEMA_MISMATCH: Existing offerings schema differs from official V001; retained without alteration.')
    return {'columns': len(actual), 'default_time_to_live': 17800}


def recover(db, config, now=None):
    # This exact table belongs to the native chart. Never accept arbitrary CQL,
    # table names, migration versions or a replacement keyspace from the UI.
    cql = config['cql']
    checksum = hashlib.sha256(cql.encode()).hexdigest()
    if checksum != config['checksum']:
        raise RecoveryError('RETRIEVAL_MIGRATION_CHECKSUM: Packaged upstream migration changed.')
    tables = db.query("SELECT table_name FROM system_schema.tables "
                      "WHERE keyspace_name='ocm' AND table_name='retrieval_schema_migration'")
    if not tables:
        return {'state': 'not-needed'}
    rows = db.query('SELECT version, name, checksum, applied_at, dirty FROM ocm.' + TABLE)
    dirty = [r for r in rows if r['dirty']]
    if not dirty:
        return {'state': 'not-needed'}
    if len(rows) != 1 or rows[0]['version'] != 1:
        raise RecoveryError('RETRIEVAL_MIGRATION_UNSUPPORTED: Unexpected migration history; retained.')
    row = rows[0]
    if row['checksum'] != checksum or row['name'] != 'create offerings table':
        raise RecoveryError('RETRIEVAL_MIGRATION_CHECKSUM: Database migration does not match the reviewed native V001; retained.')
    if not isinstance(row['applied_at'], datetime.datetime):
        raise RecoveryError('RETRIEVAL_MIGRATION_STATE: Migration timestamp is missing; retained.')
    stamp = row['applied_at'].replace(tzinfo=datetime.timezone.utc)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    age = (now - stamp).total_seconds()
    # Native 1.1.5 has a two-minute migration deadline. The five-minute guard,
    # known crashed image and conditional update avoid racing its first attempt.
    if age < 300:
        return {'state': 'settling', 'retryAfterSeconds': max(1, int(301 - age))}
    before = snapshot(row)
    verified = schema(db)
    if config['mode'] == 'inspect':
        return {'state': 'repairable', 'before': before, 'schema': verified}
    if config.get('expected') != before:
        raise RecoveryError('RETRIEVAL_MIGRATION_CHANGED: Migration changed after inspection; retained.')
    # Replay only the unchanged official, idempotent CREATE TABLE. Never drop,
    # truncate, alter or replace an existing table or its credential/offer data.
    db.query(cql)
    if schema(db) is None:
        raise RecoveryError('RETRIEVAL_SCHEMA_MISSING: Native V001 did not produce the expected table.')
    result = db.query('UPDATE ocm.' + TABLE + ' SET dirty=false, applied_at=%s WHERE version=1 '
                      'IF dirty=true AND checksum=%s AND name=%s AND applied_at=%s',
                      (now.replace(tzinfo=None), checksum, row['name'], row['applied_at']))
    if not result or result[0].get('[applied]') is not True:
        raise RecoveryError('RETRIEVAL_MIGRATION_CHANGED: Conditional repair was not applied; inspect current state.')
    after = db.query('SELECT version, name, checksum, applied_at, dirty FROM ocm.' + TABLE + ' WHERE version=1')
    if len(after) != 1 or after[0]['dirty'] or after[0]['checksum'] != checksum:
        raise RecoveryError('RETRIEVAL_MIGRATION_VERIFY: Could not verify the repaired state.')
    return {'state': 'repaired', 'before': before, 'after': snapshot(after[0]), 'schema': schema(db)}


def connect(config):
    executable = shutil.which('cqlsh')
    candidates = [pathlib.Path(executable).resolve().with_name('cqlsh.py')] if executable else []
    candidates += [pathlib.Path('/opt/cassandra/bin/cqlsh.py'), pathlib.Path('/usr/share/cassandra/bin/cqlsh.py')]
    loader = next((p for p in candidates if p.is_file()), None)
    if loader is None:
        raise RecoveryError('RETRIEVAL_RECOVERY_TOOL: Cassandra image has no bundled cqlsh Python loader.')
    runpy.run_path(str(loader), run_name='esb_cqlsh_loader')
    from cassandra import ConsistencyLevel
    from cassandra.auth import PlainTextAuthProvider
    from cassandra.cluster import Cluster
    from cassandra.query import SimpleStatement, dict_factory
    cluster = Cluster([config['host']], port=config['port'], protocol_version=4,
                      auth_provider=PlainTextAuthProvider(config['username'], config['password']),
                      connect_timeout=10, control_connection_timeout=10)
    session = cluster.connect()
    session.row_factory = dict_factory
    session.default_timeout = 30

    class Database:
        def query(self, text, params=None):
            serial = ConsistencyLevel.SERIAL if 'IF dirty=true' in text else None
            return list(session.execute(SimpleStatement(text, consistency_level=ConsistencyLevel.QUORUM,
                                                        serial_consistency_level=serial), params))

    return cluster, Database()


def main():
    config = json.load(sys.stdin)
    cluster = None
    try:
        cluster, db = connect(config)
        print(json.dumps(recover(db, config)))
    except Exception as exc:
        # Driver failures can include authentication details. Emit the class
        # only for unclassified failures; never print a traceback or config.
        message = str(exc) if isinstance(exc, RecoveryError) else 'RETRIEVAL_RECOVERY_FAILED: ' + type(exc).__name__
        if type(exc).__name__ in ['InvalidRequest', 'SyntaxException', 'Unauthorized', 'OperationTimedOut']:
            message += ': ' + str(exc)[:500]
        for key in ['username', 'password']:
            if config.get(key):
                message = message.replace(config[key], '[redacted]')
        print(json.dumps({'state': 'blocked', 'message': message}))
        return 1
    finally:
        if cluster:
            cluster.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
