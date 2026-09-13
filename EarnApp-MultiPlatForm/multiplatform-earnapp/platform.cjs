'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {PLATFORM_FINGERPRINTS}=require('./fingerprints.cjs');
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PLATFORM=/^[a-z][a-z0-9_-]{0,31}$/;
function text(value,label,fallback) {
 if(value===undefined)return fallback;
 if(typeof value!=='string'||!value.trim()||value.length>256)throw Error('Invalid '+label);
 return value;
}
function normalizeProxy(input) {
 if(!input)return undefined;
 let host,port,username='',password='';
 if(typeof input==='string') {
  const u=new URL(input);host=u.hostname;port=Number(u.port||1080);
  username=decodeURIComponent(u.username);password=decodeURIComponent(u.password);
 } else {host=input.host;port=Number(input.port||1080);username=input.username||'';password=input.password||'';}
 if(!host||host.includes('CHANGE_ME'))return undefined;
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SOCKS proxy port');
 const address=host.includes(':')&&!host.startsWith('[')?'['+host+']':host;
 return 'socks5h://'+((username||password)?encodeURIComponent(username)+':'+encodeURIComponent(password)+'@':'')+address+':'+port;
}
function selectProfile(file,requested=process.env.EARNAPP_CLIENT||'') {
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!Array.isArray(config.clients)||!config.clients.length)throw Error('spoof_config.json requires a nonempty clients array');
 const names=new Set();
 for(const c of config.clients){
  if(!c||!NAME.test(c.name)||names.has(c.name))throw Error('Profile names must be unique safe directory names');
  names.add(c.name);
 }
 const selected=config.clients.find(c=>c.name===requested)||config.clients[0];
 const fallback=!!requested&&selected.name!==requested;
 const fingerprint=selected.fingerprint && PLATFORM_FINGERPRINTS[selected.fingerprint];
 if(selected.fingerprint&&!fingerprint)throw Error('Unknown fingerprint: '+selected.fingerprint);
 const platform=fingerprint?fingerprint.prefix.slice(4,-1):text(selected.tv_platform,'tv_platform','node');
 if(!PLATFORM.test(platform))throw Error('Invalid tv_platform');
 if(selected.is_tv!==undefined&&typeof selected.is_tv!=='boolean')throw Error('is_tv must be boolean');
 const spoof=selected.spoof||{};
 if(typeof spoof!=='object'||Array.isArray(spoof))throw Error('spoof must be an object');
 const device=fingerprint?Object.fromEntries(['arch','release','os_name','ifname'].map(k=>[k,fingerprint[k]])):{};
 for(const key of ['hostname','arch','release','os_name','ifname','iftype'])
  if(spoof[key]!==undefined)device[key]=text(spoof[key],'spoof.'+key);
 return {name:selected.name,tv_platform:platform,is_tv:selected.is_tv??['webos','tizen'].includes(platform),
  appid:fingerprint?fingerprint.appid:selected.appid,hostname_prefix:fingerprint?.hostname_prefix,
  spoof:device,uuid:selected.uuid,serial:selected.serial,trackingId:selected.trackingId,
  fallback,requested,proxy:normalizeProxy(selected.proxy),mac:selected.mac};
}
function canonicalUUID(value,platform) {
 if(typeof value!=='string')throw Error('UUID must be a string');
 let uuid=value.trim().toLowerCase();
 if(/^[a-f0-9]{32}$/.test(uuid))uuid='sdk-'+platform+'-'+uuid;
 if(!uuid.startsWith('sdk-'+platform+'-')||!/^[a-f0-9]{32}$/.test(uuid.slice(('sdk-'+platform+'-').length)))
  throw Error('UUID must match selected platform '+platform+' and contain 32 hexadecimal digits');
 return uuid;
}
function prepareIdentity(profile,data,override=process.env.EARNAPP_UUID) {
 const confdir=process.env.EARNAPP_CONFDIR?path.resolve(process.env.EARNAPP_CONFDIR):path.join(data,profile.name);fs.mkdirSync(confdir,{recursive:true});
 const file=path.join(confdir,'uuid');
 let current;
 try {
  const saved=fs.readFileSync(file,'utf8').trim();
  const legacy=saved.match(/^sdk-(node|ios|windows|macos|mac|win)-([0-9a-f]{32})$/);
  if(legacy&&legacy[1]!==profile.tv_platform&&!override&&!profile.uuid) {
   const registered=['postinstall','registered'].some(n=>{try{return fs.readFileSync(path.join(confdir,n),'utf8').trim()===saved;}catch(e){if(e.code!=='ENOENT')throw e;return false;}});
   if(registered)throw Error('Saved identity is registered with a different prefix; preserved. Use a new profile name for this fingerprint.');
   const backup=path.join(confdir,'uuid.before-'+profile.tv_platform+'-prefix');
   if(!fs.existsSync(backup))fs.writeFileSync(backup,saved,{flag:'wx'});
   current='sdk-'+profile.tv_platform+'-'+legacy[2];fs.writeFileSync(file,current);
   console.log('[identity] Updated unregistered identity prefix; original backed up.');
  } else current=canonicalUUID(saved,profile.tv_platform);
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const supplied=override||profile.uuid;
 const wanted=supplied?canonicalUUID(supplied,profile.tv_platform):current;
 if(current&&wanted!==current)throw Error('Configured UUID differs from saved identity. Use a new profile name/data directory; saved identity was preserved.');
 const uuid=wanted||'sdk-'+profile.tv_platform+'-'+crypto.randomBytes(16).toString('hex');
 if(!current)fs.writeFileSync(file,uuid,{flag:'wx'});
 else if(fs.readFileSync(file,'utf8')!==uuid)fs.writeFileSync(file,uuid);
 if(profile.hostname_prefix&&!profile.spoof.hostname)profile.spoof.hostname=profile.hostname_prefix+'-'+uuid.slice(-8);
 const tracking=path.join(confdir,'tracking_id');
 if(!profile.trackingId) {
  try {profile.trackingId=fs.readFileSync(tracking,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!profile.trackingId){profile.trackingId=crypto.randomBytes(16).toString('hex');fs.writeFileSync(tracking,profile.trackingId);}
 }
 return {uuid,confdir};
}
function reportedRegistration(profile) {
 return {arch:profile.spoof.arch||os.arch(),os:profile.spoof.os_name||'Linux'};
}
module.exports={selectProfile,canonicalUUID,prepareIdentity,reportedRegistration,normalizeProxy};
