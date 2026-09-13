const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {requestJSON}=require('../registration.cjs');
function transport(mode) {
 return {request(url,options,callback){
  const request=new EventEmitter();
  request.destroy=error=>{if(error)request.emit('error',error);};
  request.end=()=>queueMicrotask(()=>{
   const socket=new EventEmitter();request.emit('socket',socket);
   socket.emit('lookup',null,'192.0.2.1',4);
   if(mode==='tcp-stall')return;
   socket.emit('connect');socket.emit('secureConnect');request.emit('finish');
   if(mode==='response-stall')return;
   const response=Readable.from([Buffer.from('{"ok":true}')]);response.statusCode=200;
   callback(response);
   if(mode==='abort')response.emit('aborted');
  });
  return request;
 }};
}
(async()=>{
 for(const [mode,phase] of [['tcp-stall','dns_resolved'],['response-stall','request_sent_waiting_response']]) {
  let report;
  await assert.rejects(requestJSON(new URL('https://example.test/install_device?uuid=private'),{},
   {transport:transport(mode),timeoutMs:20,onDiagnostic:value=>report=value}),new RegExp(phase));
  assert.equal(report.phase,phase);assert.equal(report.error_code,'ETIMEDOUT');
  assert.equal(report.endpoint,'https://example.test/install_device');
 }
 let report;
 const result=await requestJSON(new URL('https://example.test/install_device'),{},
  {transport:transport('ok'),timeoutMs:1000,onDiagnostic:value=>report=value});
 assert.equal(result.ok,true);assert.equal(report.phase,'response_complete');
 await assert.rejects(requestJSON(new URL('https://example.test/install_device'),{},
  {transport:transport('abort'),timeoutMs:1000}),/aborted/);
 console.log('PASS: TCP stall, response stall, successful response, aborted response, query redaction.');
})().catch(e=>{console.error(e);process.exitCode=1;});
