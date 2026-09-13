'use strict';
require('./offline.cjs');process.env.WS_NO_ZCOUNTER='1';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const p=path.resolve(__dirname,'../sdk/client.js');
// Expose the actual private handshake function only in an in-memory test copy.
const copy=new Module(p,module);copy.filename=p;copy.paths=Module._nodeModulePaths(path.dirname(p));
copy._compile(fs.readFileSync(p,'utf8')+'\nexports.testHandshake=tunnel_init;\n',p);
const sdk=copy.exports;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handshake-'));
try {
 const profile=require('../platform.cjs').selectProfile(path.join(__dirname,'reference-profiles.json'),process.argv[2]||'windows');
 const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'reference-fixtures',profile.name+'.json'),'utf8'));
 fs.writeFileSync(path.join(dir,'uuid'),expected.handshake.uuid);
 sdk.pre_init({confdir:dir,appid:'node_earnapp.com',partnerid:'luminati',debug:true,tv_platform:profile.tv_platform,is_tv:profile.is_tv,device_profile:profile.spoof});
 const info=sdk.testHandshake(null,{local_addr:''},null,'offline-test');
 assert.deepEqual(JSON.parse(JSON.stringify(info)),expected.handshake);
 console.log('PASS: exact reference handshake match for '+profile.name);
 fs.rmSync(dir,{recursive:true,force:true});process.exit(0);
} catch(e){console.error(e.stack);fs.rmSync(dir,{recursive:true,force:true});process.exit(1);}
