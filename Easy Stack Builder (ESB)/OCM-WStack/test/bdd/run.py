#!/usr/bin/env python3
"""Run one explicit acceptance suite and reject incomplete live evidence."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[1]
COUNTS = {'core': 15, 'credential': 3, 'clearing': 1, 'refresh': 1}


def git(*arguments):
    process = subprocess.run(['git', '-C', str(PROJECT), *arguments],
                             capture_output=True, text=True)
    return process.stdout.strip() if process.returncode == 0 else None


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=COUNTS, default='core')
    parser.add_argument('--check', action='store_true', help='Parse features and resolve steps; no HTTP.')
    parser.add_argument('--output', type=Path, help='New evidence directory outside the Git repository.')
    args = parser.parse_args()
    if not args.check:
        required = ['OCM_BASE_URL', 'OCM_USERNAME', 'OCM_PASSWORD']
        if args.suite in ('credential', 'refresh'):
            required += ['OCM_CREDENTIAL_ID']
        if args.suite == 'clearing':
            required += ['OCM_CLEARING_INPUTS_FILE']
        if args.suite == 'refresh':
            required += ['OCM_REFRESH_BODY_FILE']
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            parser.error('Missing environment variables: ' + ', '.join(missing))
    try:
        from behave.__main__ import main as behave_main
    except ImportError:
        parser.error('Install test/bdd/requirements.txt in the test virtual environment first.')
    repo = git('rev-parse', '--show-toplevel')
    root = Path(repo).resolve() if repo else PROJECT.resolve()
    temporary = None
    if args.output:
        output = args.output.expanduser().resolve()
        if output == root or root in output.parents:
            parser.error('Evidence must be written outside the repository.')
        if output.exists():
            parser.error('Choose a new output directory; existing evidence is never overwritten.')
        output.mkdir(parents=True, mode=0o700)
    elif args.check:
        temporary = tempfile.TemporaryDirectory(prefix='ocm-bdd-check-')
        output = Path(temporary.name)
    else:
        parser.error('Use --output with a new directory outside the repository.')
    os.umask(0o077)
    started = datetime.now(timezone.utc).isoformat()
    revision = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=all', '--', str(PROJECT)))
    flow_hash = digest(PROJECT / 'charts-runtime/files/flows.json')
    authored_files = {str(p.relative_to(PROJECT)): digest(p)
                      for p in ROOT.rglob('*') if p.is_file()
                      and '__pycache__' not in p.parts and p.suffix != '.pyc'}
    report = output / 'behave.json'
    arguments = [str(ROOT / 'features'), '--tags', '@' + args.suite,
                 '--format', 'json', '--outfile', str(report), '--no-snippets']
    if args.check:
        arguments += ['--dry-run']
    else:
        arguments += ['--junit', '--junit-directory', str(output / 'junit')]
    exit_code = 1
    failure = None
    scenarios = []
    try:
        exit_code = behave_main(arguments)
        features = json.loads(report.read_text())
        scenarios = [item for feature in features for item in feature.get('elements', [])
                     if item.get('type') == 'scenario' and args.suite in item.get('tags', [])]
        if len(scenarios) != COUNTS[args.suite]:
            raise AssertionError('Selected scenario count is incorrect.')
        names = [item['name'] for item in scenarios]
        if len(names) != len(set(names)):
            raise AssertionError('Duplicate scenario names are not acceptable.')
        if args.check and any(not step.get('match') for item in scenarios for step in item.get('steps', [])):
            raise AssertionError('A selected step has no binding.')
        if exit_code:
            raise AssertionError('Behave reported failed, undefined or incomplete steps.')
        if not args.check:
            if any(item.get('status') != 'passed' for item in scenarios):
                raise AssertionError('Every selected scenario must pass; skipping is not accepted.')
            steps = [step for item in scenarios for step in item.get('steps', [])]
            if not steps or any(step.get('result', {}).get('status') != 'passed' for step in steps):
                raise AssertionError('Every selected step must execute successfully.')
    except (Exception, SystemExit) as error:
        failure = str(error) if isinstance(error, AssertionError) else 'BDD execution did not complete.'
        exit_code = 1
    summary = {
        'suite': args.suite, 'mode': 'binding-check' if args.check else 'live',
        'passed': exit_code == 0, 'startedAt': started,
        'finishedAt': datetime.now(timezone.utc).isoformat(),
        'gitCommit': revision, 'workingTreeDirty': dirty, 'flowsSha256': flow_hash,
        'testFilesSha256': authored_files, 'pythonVersion': sys.version.split()[0],
        'expectedScenarios': COUNTS[args.suite], 'selectedScenarios': len(scenarios),
        'scenarios': [{'name': item['name'], 'status': item.get('status')} for item in scenarios],
        'failure': failure,
        'scope': 'Deployed API checks only; no browser, accessibility or full SRS acceptance claim.'
    }
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if failure:
        print(failure, file=sys.stderr)
    print(('Binding check' if args.check else 'Live suite') + ': ' +
          ('PASS' if exit_code == 0 else 'FAIL'))
    if not temporary:
        print('Evidence: ' + str(output))
    if temporary:
        temporary.cleanup()
    return 0 if exit_code == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
