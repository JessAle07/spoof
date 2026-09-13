const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {registerDevice}=require('../registration.cjs');const {selectProfile}=require('../platform.cjs');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reference-registration-'));
 try {
  for(const name of ['default','tizen','webos','ios','windows','macos']) {
   const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'reference-fixtures',name+'-registration.json'),'utf8'));
   const profile=selectProfile(path.join(__dirname,'reference-profiles.json'),name);profile.serial=expected.body.serial;
   const confdir=path.join(root,name);fs.mkdirSync(confdir);
   await registerDevice({uuid:expected.params.uuid,version:'1.651.510',appid:'node_earnapp.com',data:root,confdir,profile,request:async(url,body)=>{
    assert.deepEqual({endpoint:url.origin+url.pathname,params:Object.fromEntries(url.searchParams),method:'POST',body},expected);return {ok:1};
   }});
   console.log('PASS: exact reference registration fields for '+name);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
