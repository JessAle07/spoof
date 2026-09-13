'use strict';
const https=require('node:https');
const LOCAL=require('./sdk/zon_config.json').ZON_VERSION;
function parseVersion(text) {return text.match(/^VERSION\s*=\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/m)?.[1];}
function fetchText(url,remaining=5) {
 return new Promise((resolve,reject)=>{
  let req;
  try {
   req=https.get(url,{headers:{'User-Agent':'curl/8.0'}},res=>{
    if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&remaining>0){
     res.resume();const next=new URL(res.headers.location,url);if(next.protocol!=='https:')return reject(Error('Version redirect must use HTTPS'));
     return resolve(fetchText(next,remaining-1));
    }
    if(res.statusCode!==200){res.resume();return reject(Error('Version HTTP '+res.statusCode));}
    let text='';res.setEncoding('utf8');res.on('data',s=>{text+=s;if(text.length>1024*1024)res.destroy(Error('Version document too large'));});
    res.on('error',reject);res.on('end',()=>resolve(text));
   });
   req.on('error',reject);req.setTimeout(8000,()=>req.destroy(Error('Version lookup timeout')));
  }catch(e){reject(e);}
 });
}
async function resolveVersion(fetch=fetchText) {
 if(process.env.EARNAPP_VERSION_MODE==='local')return {installed:LOCAL,reported:LOCAL,source:'local'};
 const url=process.env.EARNAPP_VERSION_URL||'https://brightdata.com/static/earnapp/install.sh';
 try {
  const parsed=new URL(url);if(parsed.protocol!=='https:')throw Error('Version URL must use HTTPS');
  const version=parseVersion(await fetch(parsed));if(!version)throw Error('VERSION not found');
  console.log(`[version] installer reports ${version}; installed SDK ${LOCAL}`);
  return {installed:LOCAL,reported:version,source:'installer'};
 }catch(e){console.warn(`[version] lookup failed; using installed SDK ${LOCAL}: ${e.message}`);return {installed:LOCAL,reported:LOCAL,source:'local-fallback'};}
}
module.exports={parseVersion,resolveVersion};
