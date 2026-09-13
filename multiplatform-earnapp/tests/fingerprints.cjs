'use strict';
require('./offline.cjs');
process.env.WS_NO_ZCOUNTER='1';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {PLATFORM_FINGERPRINTS}=require('../fingerprints.cjs');
const {selectProfile,prepareIdentity}=require('../platform.cjs');
const {registerDevice}=require('../registration.cjs');
const source=path.resolve(__dirname,'../sdk/client.js');
(async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'fingerprints-'));
 try {
 for(const [name,fp] of Object.entries(PLATFORM_FINGERPRINTS)) {
  const p=selectProfile(path.join(__dirname,'../spoof_config.json'),name);
  const identity=prepareIdentity(p,data,'');
  assert.ok(identity.uuid.startsWith(fp.prefix));assert.equal(p.appid,fp.appid);
  assert.equal(p.spoof.hostname,fp.hostname_prefix+'-'+identity.uuid.slice(-8));
  assert.equal(prepareIdentity(p,data,'').uuid,identity.uuid);
const copy=new Module(source,module);copy.filename=source;copy.paths=Module._nodeModulePaths(path.dirname(source));
copy._compile(fs.readFileSync(source,'utf8')+'\nexports.testHandshake=tunnel_init;',source);
const sdk=copy.exports;
  sdk.pre_init({confdir:identity.confdir,appid:p.appid,partnerid:'luminati',debug:true,tv_platform:p.tv_platform,is_tv:false,device_profile:p.spoof,...p.spoof});
  const handshake=sdk.testHandshake(null,{local_addr:''},null,'offline-test');
  assert.equal(handshake.uuid,identity.uuid);assert.equal(handshake.platform,fp.prefix.slice(4,-1));
  assert.equal(handshake.arch,fp.arch);assert.equal(handshake.release,fp.release);
  assert.equal(handshake.appid,require('../sdk/alias.js').compute(fp.appid,p.tv_platform));
  await registerDevice({...identity,data,profile:p,appid:'node_earnapp.com',version:'1.651.510',request:async url=>{
   assert.equal(url.searchParams.get('appid'),fp.appid);assert.equal(url.searchParams.get('os'),fp.os_name);
   assert.equal(url.searchParams.get('arch'),fp.arch);assert.equal(url.searchParams.get('uuid'),identity.uuid);return {ok:true};
  }});
  console.log('PASS fingerprint registration and SDK handshake: '+name);
 }
 const p=selectProfile(path.join(__dirname,'../spoof_config.json'),'ios');
 fs.unlinkSync(path.join(data,'ios','postinstall'));fs.writeFileSync(path.join(data,'ios','uuid'),'sdk-node-'+'a'.repeat(32));
 assert.equal(prepareIdentity(p,data,'').uuid,'sdk-ios-'+'a'.repeat(32));
 fs.writeFileSync(path.join(data,'ios','uuid'),'sdk-node-'+'b'.repeat(32));fs.writeFileSync(path.join(data,'ios','postinstall'),'sdk-node-'+'b'.repeat(32));
 assert.throws(()=>prepareIdentity(p,data,''),/preserved/);
 }finally{fs.rmSync(data,{recursive:true,force:true});}
})().then(()=>process.exit(0),e=>{fs.writeSync(2,e.stack+'\n');process.exit(1)});
