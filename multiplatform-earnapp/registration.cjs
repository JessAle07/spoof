'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const https=require('node:https');
const os=require('node:os');
function atomicWrite(file,text) {
 const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,text);fs.renameSync(temp,file);
}
function requestJSON(url,payload,options={}) {
 const timeoutMs=options.timeoutMs??30000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>300000)
  return Promise.reject(Error('Registration timeout must be between 1 and 300000 ms'));
 const transport=options.transport||https;
 return new Promise((resolve,reject)=>{
  const start=Date.now();
  const diagnostic={endpoint:url.origin+url.pathname,timeout_ms:timeoutMs,
   phase:'creating_request',events:[],http_status:null};
  const record=phase=>{diagnostic.phase=phase;diagnostic.events.push({phase,elapsed_ms:Date.now()-start});};
  let done=false,timer,req;
  const finish=(error,result)=>{
   if(done)return;done=true;clearTimeout(timer);
   diagnostic.elapsed_ms=Date.now()-start;
   diagnostic.outcome=error?'failed':'received_json';
   if(error){diagnostic.error=error.message;diagnostic.error_code=error.code||null;}
   try {options.onDiagnostic?.(diagnostic);}catch(e){console.error('Could not save registration diagnostic:',e.message);}
   error?reject(error):resolve(result);
  };
  const body=JSON.stringify(payload);
  try {
   req=transport.request(url,{method:'POST',...options.requestOptions,headers:{'User-Agent':'axios/0.32.0','Content-Type':'application/json',
    'Content-Length':Buffer.byteLength(body),'Accept':'application/json, text/plain, */*'}},res=>{
    record('response_headers');diagnostic.http_status=res.statusCode;
    let chunks=[],size=0;
    res.on('data',chunk=>{
     record('response_body');size+=chunk.length;
     if(size>1024*1024){const e=Error('Registration response exceeds 1 MiB');finish(e);res.destroy(e);}
     else chunks.push(chunk);
    });
    res.on('error',error=>finish(error));
    res.on('aborted',()=>finish(Error('Registration response was aborted before completion')));
    res.on('end',()=>{
     if(res.statusCode!==200)return finish(Error('Registration HTTP '+res.statusCode));
     try {const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));record('response_complete');finish(null,result);}
     catch {finish(Error('Registration returned invalid JSON'));}
    });
   });
   req.on('socket',socket=>{
    record('socket_assigned');
    if(req.reusedSocket){record('reused_connection');return;}
    socket.once('lookup',(error,address,family)=>{
     if(error){record('dns_failed');return;}
     diagnostic.address_family=family;record('dns_resolved');
    });
    socket.once('connect',()=>record('tcp_connected'));
    socket.once('secureConnect',()=>record('tls_connected'));
   });
   req.on('finish',()=>record('request_sent_waiting_response'));
   req.on('error',error=>finish(error));
   timer=setTimeout(()=>{
    const error=Error('Registration timed out after '+timeoutMs/1000+' seconds; last phase: '+diagnostic.phase);
    error.code='ETIMEDOUT';finish(error);req.destroy(error);
   },timeoutMs);
   req.end(body);
  }catch(error){finish(error);}
 });
}
async function registerDevice({uuid,version,appid,confdir,data,profile,request}) {
 const platform=profile?.tv_platform||'node';
 uuid=require('./platform.cjs').canonicalUUID(uuid,platform);
 const marker=path.join(confdir,'postinstall');
 const link='https://earnapp.com/r/'+uuid;
 let existing;try {existing=fs.readFileSync(marker,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
 if(existing===uuid) {
  atomicWrite(path.join(confdir,'earnapp.txt'),link+'\n');atomicWrite(path.join(data,'earnapp.txt'),link+'\n');return {link,cached:true};
 }
 const serialPath=path.join(confdir,'installation-serial');
 let serial;
 try {serial=fs.readFileSync(serialPath,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
 if(serial && !/^[a-f0-9]{40}$/.test(serial))throw Error('Invalid saved installation serial');
 if(profile?.serial){
  if(typeof profile.serial!=='string'||!/^[a-f0-9]{40}$/.test(profile.serial))throw Error('Profile serial must contain 40 lowercase hex digits');
  if(serial&&serial!==profile.serial)throw Error('Profile serial differs from saved installation serial');
  serial=profile.serial;atomicWrite(serialPath,serial+'\n');
 }
 if(!serial){serial=crypto.randomBytes(20).toString('hex');atomicWrite(serialPath,serial+'\n');}
 const url=new URL('https://client.earnapp.com/install_device');
 const reported=profile?require('./platform.cjs').reportedRegistration(profile):{arch:os.arch(),os:os.platform()};
 url.search=new URLSearchParams({uuid,version,...reported,appid:profile?.appid||appid}).toString();
 const seconds=Number(process.env.REGISTRATION_TIMEOUT_SECONDS||'30');
 if(!Number.isFinite(seconds)||seconds<1||seconds>300)throw Error('REGISTRATION_TIMEOUT_SECONDS must be 1..300');
 const requestOptions=profile?.proxy?{agent:new (require('./sdk/node_modules/socks-proxy-agent').SocksProxyAgent)(profile.proxy)}:{};
 const send=request||((url,payload)=>requestJSON(url,payload,{timeoutMs:seconds*1000,requestOptions,
  onDiagnostic:diagnostic=>atomicWrite(path.join(confdir,'registration-diagnostic.json'),JSON.stringify(diagnostic,null,2)+'\n')}));
 const result=await send(url,{serial});
 if(!result || (!result.ok && !result.preinstall))throw Error('Registration was not accepted: expected a truthy ok or preinstall field');
 atomicWrite(marker,uuid+'\n');
 atomicWrite(path.join(confdir,'earnapp.txt'),link+'\n');atomicWrite(path.join(data,'earnapp.txt'),link+'\n');
 return {link,cached:false};
}
module.exports={registerDevice,requestJSON};
