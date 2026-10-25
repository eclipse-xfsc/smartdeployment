'use strict';
class AppError extends Error {
  constructor(status, code) { super(code); this.status=status; this.code=code; }
}
const fail=(status,code)=>{throw new AppError(status,code);};
function object(x,allowed) {
  if (!x || typeof x!=='object' || Array.isArray(x)) fail(400,'VALIDATION_ERROR');
  if (allowed && Object.keys(x).some(k=>!allowed.includes(k))) fail(400,'VALIDATION_ERROR');
  return x;
}
function string(x,min=1,max=256) {
  if(typeof x!=='string'||x.length<min||x.length>max||/[\x00-\x1f\x7f]/.test(x))fail(400,'VALIDATION_ERROR');
  return x;
}
const id=x=>encodeURIComponent(string(x,1,512));
module.exports={AppError,fail,object,string,id};
