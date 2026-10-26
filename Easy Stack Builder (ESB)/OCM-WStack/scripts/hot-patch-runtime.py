#!/usr/bin/env python3
"""Update only the managed OCM runtime seed and roll out its Deployment."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def seed_digest(data, binary):
    return hashlib.sha256(data['seed.sh'].encode() + base64.b64decode(binary['runtime.tgz']) + base64.b64decode(binary['ui.tgz'])).hexdigest()


def patch_resources(run, backup, seed, deployment, data, binary, checksum):
    # Compare resource versions to avoid overwriting another administrator's update.
    run('patch', 'configmap', seed['metadata']['name'], '--type=json', '-p', json.dumps([
        {'op': 'test', 'path': '/metadata/resourceVersion', 'value': seed['metadata']['resourceVersion']},
        {'op': 'add', 'path': '/data', 'value': data},
        {'op': 'add', 'path': '/binaryData', 'value': binary},
    ]))
    annotations = dict(deployment['spec']['template']['metadata'].get('annotations', {}))
    if checksum is None:
        annotations.pop('checksum/seed', None)
    else:
        annotations['checksum/seed'] = checksum
    run('patch', 'deployment', deployment['metadata']['name'], '--type=json', '-p', json.dumps([
        {'op': 'test', 'path': '/metadata/resourceVersion', 'value': deployment['metadata']['resourceVersion']},
        {'op': 'add', 'path': '/spec/template/metadata/annotations', 'value': annotations},
    ]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kubeconfig', required=True, type=Path)
    parser.add_argument('--host', default='ocm-osc.facis.cloud')
    parser.add_argument('--namespace', default='ocm-wstack')
    parser.add_argument('--deployment', default='ocm-orce')
    parser.add_argument('--timeout', default='20m')
    parser.add_argument('--backup-dir', type=Path, default=Path.home() / 'Desktop/dev_ocm_cr/runtime-backups')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    kubeconfig = args.kubeconfig.expanduser().resolve(strict=True)
    prefix = ['kubectl', '--kubeconfig=' + str(kubeconfig), '-n', args.namespace]

    def run(*arguments, input_data=None):
        # JSON patch can exceed the OS argument limit; send it as a temporary file.
        arguments = list(arguments)
        if '-p' in arguments:
            import tempfile
            index = arguments.index('-p')
            with tempfile.NamedTemporaryFile('w', prefix='ocm-patch-', suffix='.json') as patch:
                patch.write(arguments[index + 1]); patch.flush()
                arguments[index:index + 2] = ['--patch-file', patch.name]
                return subprocess.check_output(prefix + ['--request-timeout=45s'] + arguments, text=True)
        return subprocess.check_output(prefix + ['--request-timeout=45s'] + arguments, input=input_data, text=True)

    deployment = json.loads(run('get', 'deployment', args.deployment, '-o', 'json'))
    pod_spec = deployment['spec']['template']['spec']
    volumes = {v['name']: v for v in pod_spec['volumes']}
    seed_name = volumes['seed']['configMap']['name']
    config_name = volumes['config']['configMap']['name']
    config = json.loads(json.loads(run('get', 'configmap', config_name, '-o', 'json'))['data']['config.json'])
    if config.get('publicOrigin') != 'https://' + args.host:
        raise RuntimeError('Runtime publicOrigin does not match --host; no changes made.')
    init = next(c for c in pod_spec['initContainers'] if c['name'] == 'seed-orce-runtime')
    if init.get('command') != ['/bin/sh', '/seed/seed.sh']:
        raise RuntimeError('The deployment uses a different seed command; no changes made.')
    if deployment['spec']['selector']['matchLabels'] != {'app': 'ocm-orce'}:
        raise RuntimeError('Unexpected runtime selector; no changes made.')
    seed = json.loads(run('get', 'configmap', seed_name, '-o', 'json'))
    if args.rollback:
        backup = json.loads(args.rollback.expanduser().read_text())
        if (backup['host'], backup['namespace'], backup['deployment']['metadata']['uid'], backup['seed']['metadata']['uid']) != (args.host, args.namespace, deployment['metadata']['uid'], seed['metadata']['uid']):
            raise RuntimeError('Backup belongs to another runtime; no changes made.')
        current_digest = seed_digest(seed['data'], seed['binaryData'])
        if current_digest not in (backup['installedDigest'], seed_digest(backup['seed']['data'], backup['seed']['binaryData'])):
            raise RuntimeError('The seed has changed since this patch; preserve those edits before rollback.')
        data, binary = backup['seed']['data'], backup['seed']['binaryData']
        checksum = backup['deployment']['spec']['template']['metadata'].get('annotations', {}).get('checksum/seed')
        print('Restoring runtime seed from', args.rollback, flush=True)
    else:
        # A seeded runtime must retain its managed-volume marker and release links.
        check = "const fs=require('fs'); if(!fs.existsSync('/data/OCM-UI-V3-MANAGED') || !fs.lstatSync('/data/current').isSymbolicLink()) process.exit(1); console.log('Current runtime:',require('/data/current/package.json').version)"
        print(run('exec', 'deployment/' + args.deployment, '-c', 'orce', '--', 'node', '-e', check).strip(), flush=True)
        files = Path(__file__).resolve().parents[1] / 'charts-runtime/files'
        data = {**seed.get('data', {}), 'seed.sh': (files / 'seed.sh').read_text()}
        binary = {**seed.get('binaryData', {}), **{name: base64.b64encode((files / name).read_bytes()).decode() for name in ('runtime.tgz', 'ui.tgz')}}
        checksum = seed_digest(data, binary)
        if len(json.dumps({'data': data, 'binaryData': binary})) > 1000000:
            raise RuntimeError('Seed exceeds the ConfigMap size budget; no changes made.')
        if seed_digest(seed['data'], seed['binaryData']) == checksum and deployment['spec']['template']['metadata'].get('annotations', {}).get('checksum/seed') == checksum:
            print('The 12.5.11 runtime seed is already applied. Checking rollout.', flush=True)
            backup = None
        else:
            args.backup_dir.expanduser().mkdir(parents=True, exist_ok=True)
            timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            backup_path = args.backup_dir.expanduser() / ('ocm-runtime-before-12.5.11-' + timestamp + '.json')
            backup = {'host': args.host, 'namespace': args.namespace, 'seed': seed, 'deployment': deployment, 'installedDigest': checksum}
            with backup_path.open('x') as handle:
                json.dump(backup, handle, indent=2)
            print('Backup:', backup_path, flush=True)
            print('Updating runtime seed for https://' + args.host + '/orce/', flush=True)
    if args.rollback or backup is not None:
        patch_resources(run, backup, seed, deployment, data, binary, checksum)
    subprocess.run(prefix + ['rollout', 'status', 'deployment/' + args.deployment, '--timeout=' + args.timeout], check=True)
    print(run('exec', 'deployment/' + args.deployment, '-c', 'orce', '--', 'node', '-e', "console.log('Runtime version:',require('/data/current/package.json').version); fetch('http://127.0.0.1:1880/orce/ui-api/v1/health/ready',{signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.json(); console.log(JSON.stringify(b)); if(!r.ok)process.exitCode=1;}).catch(()=>{process.exitCode=1;})").strip())
    print('UI: https://' + args.host + '/orce/ — reload the page before using Clearing Center.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print('Stopped:', error, file=sys.stderr)
        print('If a backup was printed, it is available for --rollback. Inspect seed-orce-runtime logs with the same --kubeconfig.', file=sys.stderr)
        sys.exit(1)
