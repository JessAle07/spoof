const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {registerDevice}=require('../registration.cjs');
(async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'edge-register-'));const confdir=path.join(data,'default');fs.mkdirSync(confdir);
 try {
  const opts={uuid:'sdk-node-'+'a'.repeat(32),version:'1.651.510',appid:'node_earnapp.com',data,confdir};
  await assert.rejects(registerDevice({...opts,request:async()=>({ok:false})}));
  assert.equal(fs.existsSync(path.join(confdir,'postinstall')),false);
  assert.equal(fs.existsSync(path.join(data,'earnapp.txt')),false);
  let requests=0;
  const request=async(url,body)=>{requests++;assert.equal(url.searchParams.get('os'),os.platform());assert.equal(url.searchParams.get('appid'),'node_earnapp.com');assert.match(body.serial,/^[a-f0-9]{40}$/);return {ok:true};};
  const result=await registerDevice({...opts,request});assert.equal(result.cached,false);
  assert.equal(fs.readFileSync(path.join(data,'earnapp.txt'),'utf8').trim(),result.link);
  const cached=await registerDevice({...opts,request});assert.equal(cached.cached,true);assert.equal(requests,1);
  console.log('PASS: rejected registration creates no marker/link; success persists link; repeat uses marker.');
 } finally {fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
