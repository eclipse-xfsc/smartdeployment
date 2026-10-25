'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');

// kubectl opens --patch-file as a pathname. Node's spawned stdin is a socket,
// so /dev/stdin cannot be reopened. Keep secret payloads out of argv and logs.
async function privatePatch(r,args,patch){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'esb-patch-'));
 const file=path.join(directory,'patch.json');
 try{
  await fs.chmod(directory,0o700);
  await fs.writeFile(file,JSON.stringify(patch),{mode:0o600,flag:'wx'});
  return await r.run('kubectl',[...args,'--patch-file',file]);
 }finally{
  await fs.rm(directory,{recursive:true,force:true});
 }
}
module.exports={privatePatch};
