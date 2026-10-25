#!/usr/bin/env python3
from pathlib import Path
import tarfile, gzip, io
root=Path(__file__).resolve().parents[1]
out=root/'ORCE Runtime/files/runtime.tgz'
with out.open('wb') as stream:
 with gzip.GzipFile(filename='',mode='wb',fileobj=stream,mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w') as tar:
   for f in sorted((root/'runtime').rglob('*')):
    if not f.is_file() or 'node_modules' in f.parts:continue
    name=f.relative_to(root/'runtime').as_posix()
    data=f.read_bytes();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if f.suffix=='.sh' else 0o644;info.mtime=0;tar.addfile(info,io.BytesIO(data))
print(out)
