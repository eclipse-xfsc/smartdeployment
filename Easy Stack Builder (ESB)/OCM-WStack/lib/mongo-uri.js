'use strict';
const {fail}=require('./config');
function ports(uri){
 const match=/^(mongodb(?:\+srv)?):\/\/([^/?]+)(?:\/[^?]*)?(?:\?.*)?$/.exec(uri||'');
 if(!match)fail('RUNTIME_CREDENTIALS','External MongoDB requires a valid mongodb:// or mongodb+srv:// URI.');
 const hosts=match[2].slice(match[2].lastIndexOf('@')+1).split(',');
 if(match[1]==='mongodb+srv'&&hosts.length!==1)fail('RUNTIME_CREDENTIALS','MongoDB SRV requires one DNS host.');
 const result=[];
 for(const host of hosts){let u;try{u=new URL('mongodb://'+host);if(!u.hostname||u.username||u.password||u.pathname&&u.pathname!=='/')throw Error();}catch{fail('RUNTIME_CREDENTIALS','Invalid external MongoDB host/port.');}if(match[1]==='mongodb+srv'&&u.port)fail('RUNTIME_CREDENTIALS','MongoDB SRV cannot specify a port.');const port=Number(u.port||27017);if(port<1||port>65535)fail('RUNTIME_CREDENTIALS','Invalid external MongoDB port.');result.push(port);}
 return [...new Set(result)];
}
module.exports={ports};
