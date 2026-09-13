const assert=require('node:assert/strict');const {parseVersion,resolveVersion}=require('../version.cjs');
(async()=>{
 assert.equal(parseVersion('VERSION="1.2.3"\n'), '1.2.3');
 assert.equal(parseVersion('VERSION=\'1.2.3\''),'1.2.3');assert.equal(parseVersion('invalid'),undefined);
 delete process.env.EARNAPP_VERSION_MODE;
 const remote=await resolveVersion(async()=> 'VERSION="9.8.7"');assert.equal(remote.installed,'1.651.510');assert.equal(remote.reported,'9.8.7');
 const fallback=await resolveVersion(async()=>{throw Error('test offline')});assert.equal(fallback.reported,'1.651.510');
 console.log('PASS: installer VERSION parsing, reported version selection, local fallback.');
})().catch(e=>{console.error(e);process.exitCode=1});
