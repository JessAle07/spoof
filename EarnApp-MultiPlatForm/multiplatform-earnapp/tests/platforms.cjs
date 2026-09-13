'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {selectProfile,prepareIdentity,reportedRegistration}=require('../platform.cjs');
const {registerDevice}=require('../registration.cjs');
const config=path.join(__dirname,'../spoof_config.json');
(async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'platforms-'));
 try {
  const seen=new Set();
  for(const name of ['default','ios','windows','macos','tizen','webos']) {
   const p=selectProfile(config,name);const identity=prepareIdentity(p,data,'');
   assert.equal(p.name,name);assert.ok(identity.uuid.startsWith('sdk-'+p.tv_platform+'-'));
   assert.equal(prepareIdentity(p,data,'').uuid,identity.uuid);assert.ok(!seen.has(identity.uuid));seen.add(identity.uuid);
   await registerDevice({...identity,data,profile:p,version:'1.651.510',appid:'node_earnapp.com',request:async(url)=>{
    assert.equal(url.searchParams.get('uuid'),identity.uuid);
    assert.equal(url.searchParams.get('os'),reportedRegistration(p).os);
    assert.equal(url.searchParams.get('arch'),reportedRegistration(p).arch);
    assert.equal(url.searchParams.get('appid'),p.appid||'node_earnapp.com');return {ok:true};
   }});
   assert.equal(fs.readFileSync(path.join(identity.confdir,'earnapp.txt'),'utf8').trim(),'https://earnapp.com/r/'+identity.uuid);
  }
  assert.equal(selectProfile(config,'missing').name,'tizen');assert.equal(selectProfile(config,'missing').fallback,true);
  const p=selectProfile(config,'windows');const before=prepareIdentity(p,data,'').uuid;
  assert.throws(()=>prepareIdentity(p,data,'a'.repeat(32)),/differs/);
  assert.equal(prepareIdentity(p,data,'').uuid,before);
  console.log('PASS: six profile selections, registration fields, distinct persistent UUIDs, saved links, fallback and overwrite protection.');
 } finally {fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
