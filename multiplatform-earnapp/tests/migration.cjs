const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareIdentity}=require('../platform.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-'));
try{
 const dir=path.join(root,'ios');fs.mkdirSync(dir);const old='sdk-ios-'+'a'.repeat(32);
 fs.writeFileSync(path.join(dir,'uuid'),old);
 const p={name:'ios',tv_platform:'node'};const next=prepareIdentity(p,root,'');
 assert.equal(next.uuid,'sdk-node-'+'a'.repeat(32));
 assert.equal(fs.readFileSync(path.join(dir,'uuid.before-node-prefix'),'utf8'),old);
 assert.match(fs.readFileSync(path.join(dir,'tracking_id'),'utf8'),/^[a-f0-9]{32}$/);
 const keep=path.join(root,'windows');fs.mkdirSync(keep);const id='sdk-windows-'+'b'.repeat(32);
 fs.writeFileSync(path.join(keep,'uuid'),id);fs.writeFileSync(path.join(keep,'postinstall'),id);
 assert.throws(()=>prepareIdentity({name:'windows',tv_platform:'node'},root,''),/preserved/);
 assert.equal(fs.readFileSync(path.join(keep,'uuid'),'utf8'),id);
 console.log('PASS: failed identity migrated with backup; registered identity preserved; tracking ID persisted.');
}finally{fs.rmSync(root,{recursive:true,force:true})}
