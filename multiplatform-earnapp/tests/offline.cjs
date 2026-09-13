// Preload used only by tests. Block socket connects and DNS, without changing SDK files.
const net=require('node:net');
net.Socket.prototype.connect=function(){throw Error('OFFLINE_TEST_NETWORK_BLOCKED');};
const dns=require('node:dns');
for(const name of ['resolve','resolve4','resolve6','lookup','reverse']) {
 dns.promises[name]=async()=>{throw Error('OFFLINE_TEST_DNS_BLOCKED');};
 dns[name]=(...args)=>{const callback=args.at(-1);if(typeof callback==='function')queueMicrotask(()=>callback(Error('OFFLINE_TEST_DNS_BLOCKED')));else throw Error('OFFLINE_TEST_DNS_BLOCKED');};
}
const dgram=require('node:dgram');
dgram.Socket.prototype.send=function(){throw Error('OFFLINE_TEST_UDP_BLOCKED');};
// Simulate only the registration endpoint. All actual sockets remain blocked.
const https=require('node:https');
const originalRequest=https.request;
https.request=function(url,opts,callback) {
 if(url instanceof URL && url.hostname==='client.earnapp.com' && url.pathname==='/install_device') {
  const {Writable,Readable}=require('node:stream');
  return new Writable({write(chunk,encoding,next){next();},final(next){
   next();const response=Readable.from([Buffer.from('{"ok":true}')]);response.statusCode=200;callback(response);
  }});
 }
 return originalRequest.apply(this,arguments);
};

// Stable test-only interface inventory; this environment blocks OS interface enumeration.
require('node:os').networkInterfaces=()=>({eth0:[{family:'IPv4',internal:false,
 address:'192.0.2.10',netmask:'255.255.255.0',mac:'02:00:00:00:00:01',cidr:'192.0.2.10/24'}]});
