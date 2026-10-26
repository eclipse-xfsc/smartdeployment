#!/usr/bin/env python3
"""Build the editable runtime seed, npm TGZ, source ZIP and checksum list.

Usage: python3 scripts/build-release.py /absolute/output/directory
No dependency installation, code generation or service binary build is performed.
"""
import gzip, hashlib, io, json, pathlib, subprocess, sys, tarfile, zipfile

root = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else root.parent / 'release'
if out == root or root in out.parents:
    raise SystemExit('Keep release artifacts outside the source directory.')
out.mkdir(parents=True, exist_ok=True)
version = json.loads((root / 'package.json').read_text())['version']

# Package runtime and editable UI sources for the ORCE init container.
for directory in ('runtime', 'ui'):
    source = root / directory
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for p in sorted(source.rglob('*')):
            if not p.is_file():
                continue
            if any(part in {'node_modules', '.git', '__pycache__'} for part in p.relative_to(source).parts):
                continue
            if p.is_symlink():
                raise SystemExit(f'Unexpected seed content: {p.relative_to(root)}')
            info = tarfile.TarInfo(p.relative_to(source).as_posix())
            data = p.read_bytes()
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    (root / f'charts-runtime/files/{directory}.tgz').write_bytes(gzip.compress(buffer.getvalue(), mtime=0))

files = []
for p in sorted(root.rglob('*')):
    if not p.is_file() or p.name == 'SOURCE-MANIFEST.sha256' or (p.parent == root and p.suffix in {'.tgz', '.zip'}):
        continue
    if any(part in {'node_modules', '.git', '__pycache__'} for part in p.relative_to(root).parts):
        continue
    if p.is_symlink():
        raise SystemExit(f'Unexpected package content: {p.relative_to(root)}')
    files.append(p)
manifest = root / 'SOURCE-MANIFEST.sha256'
manifest.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root).as_posix()}\n' for p in files))
files.append(manifest)

result = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(out)], cwd=root, check=True, capture_output=True, text=True)
pack = json.loads(result.stdout)[0]
tgz = out / pack['filename']
source_zip = out / f'OCM-WStack-{version}-Source.zip'
with zipfile.ZipFile(source_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for p in sorted(files):
        name = 'Easy Stack Builder (ESB)/OCM-WStack/' + p.relative_to(root).as_posix()
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 23, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if p.stat().st_mode & 0o111 else 0o100644) << 16
        archive.writestr(info, p.read_bytes())
validation = out / f'OCM-WStack-{version}-Validation.md'
validation.write_bytes((root / 'VALIDATION.md').read_bytes())
checksum = out / f'OCM-WStack-{version}-SHA256SUMS.txt'
checksum.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in [tgz, source_zip, validation]))
print(json.dumps({'version': version, 'npm_files': pack['entryCount'], 'source_files': len(files), 'artifacts': [{'path': str(p), 'bytes': p.stat().st_size} for p in [tgz, source_zip, validation, checksum]]}, indent=2))
