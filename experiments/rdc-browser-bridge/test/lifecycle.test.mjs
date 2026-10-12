import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createBridge} from '../src/server.mjs';

const secret=()=>randomBytes(32).toString('hex');
const backendStub={async status(){return {state:'ready'}},async snapshot(){return {origin:'http://127.0.0.1:9240',aria:'safe'}}};
async function open(options={}){
 const token=secret();const bridge=await createBridge({deviceId:'test-cube',token,backend:backendStub,allowedOrigins:['http://127.0.0.1:9240'],enabled:{rdc_browser_status:true,rdc_browser_snapshot:true},authorize:()=> 'ALLOW',...options});
 const client=new Client({name:'lifecycle-probe',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
 return {token,bridge,client};
}
test('a hung browser snapshot receives an abort signal on deadline',async()=>{
 let sawAbort=false,reason;
 const backend={async status(){return {state:'ready'}},snapshot({signal}={}){
  return new Promise((resolve,reject)=>{
   if(!signal){reject(Error('missing backend AbortSignal'));return}
   signal.addEventListener('abort',()=>{sawAbort=true;reason=signal.reason?.message;reject(Error('cancelled'))},{once:true});
  });
 }};
 const t=await open({backend});
 try{
  const outcome=await t.client.callTool({name:'rdc_browser_snapshot',arguments:{}});
  assert.equal(outcome.isError,true);
  assert.equal(sawAbort,true,'underlying backend needs cancellation on deadline');
  assert.equal(reason,'operation_timeout','deadline abort must be distinguishable from user cancellation');
 }finally{await t.client.close();await t.bridge.close()}
});
test('timed-out policy decision receives a cancellation signal',async()=>{
 let sawAbort=false;
 const t=await open({authorize:({signal}={})=>new Promise((resolve)=>{
   if(signal)signal.addEventListener('abort',()=>{sawAbort=true;resolve('DENY')},{once:true});
 })});
 try{
  const result=await t.client.callTool({name:'rdc_browser_status',arguments:{}});
  assert.equal(result.isError,true);
  assert.equal(sawAbort,true,'trusted policy callback must be cancelled');
 }finally{await t.client.close();await t.bridge.close()}
});
test('raw TCP clients cannot exceed a fixed number of simultaneously open sockets',async()=>{
 const t=await open();
 const url=new URL(t.bridge.url);const sockets=[];
 try{
  for(let i=0;i<24;i++){
   const s=net.createConnection({host:'127.0.0.1',port:Number(url.port)});
   sockets.push(s);s.on('error',()=>{});
   await new Promise(resolve=>{s.once('connect',resolve);s.once('error',resolve)});
   if(!s.destroyed)s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:'+url.port+'\r\n');
  }
  await new Promise(resolve=>setTimeout(resolve,250));
  const openCount=sockets.filter(x=>!x.destroyed).length;
  assert.ok(openCount<=16,'open socket count '+openCount+' must not exceed 16');
 }finally{
  sockets.forEach(x=>x.destroy());
  await t.client.close();
  await t.bridge.close();
 }
});

test('bridge shutdown aborts an active cooperative backend before completing',async()=>{
 let signalWasAborted=false,entered;
 const started=new Promise(resolve=>{entered=resolve});
 const backend={async status(){return {state:'ready'}},snapshot({signal}){
  entered();return new Promise((_,reject)=>{
   signal.addEventListener('abort',()=>{signalWasAborted=true;reject(Error('cancelled'))},{once:true});
  });
 }};
 const t=await open({backend});
 let stopped=false;
 const inflight=t.client.callTool({name:'rdc_browser_snapshot',arguments:{}}).catch(()=>null);
 try{
  await started;
  await Promise.race([t.bridge.close(),new Promise((_,reject)=>setTimeout(()=>reject(Error('shutdown stalled')),1100))]);
  stopped=true;
  assert.equal(signalWasAborted,true);
 }finally{await t.client.close().catch(()=>{});if(!stopped)await t.bridge.close().catch(()=>{});await inflight}
});
test('releasing a raw TCP slot permits a fresh connection',async()=>{
 const t=await open();const url=new URL(t.bridge.url);const sockets=[];
 try{
  for(let i=0;i<16;i++){
   const s=net.createConnection({host:'127.0.0.1',port:Number(url.port)});s.on('error',()=>{});
   sockets.push(s);
   await new Promise(resolve=>{s.once('connect',resolve);s.once('error',resolve)});
   if(!s.destroyed)s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:'+url.port+'\r\n');
  }
  sockets[0].destroy();
  await new Promise(resolve=>setTimeout(resolve,70));
  const next=net.createConnection({host:'127.0.0.1',port:Number(url.port)});next.on('error',()=>{});sockets.push(next);
  await new Promise(resolve=>{next.once('connect',resolve);next.once('error',resolve)});
  if(!next.destroyed)next.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:'+url.port+'\r\n');
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(next.destroyed,false,'released slot should admit a new socket');
 }finally{sockets.forEach(s=>s.destroy());await t.client.close().catch(()=>{});await t.bridge.close()}
});

test('closing the bridge disposes its trusted backend exactly once',async()=>{
 let disposed=0;
 const t=await open({backend:{...backendStub,dispose(){disposed++}}});
 await t.client.close();
 await t.bridge.close();
 assert.equal(disposed,1);
});
test('client abort cancels an in-flight authenticated MCP snapshot',async()=>{
 let resolveStarted;
 const started=new Promise(resolve=>{resolveStarted=resolve});
 let aborted=false;
 const backend={async status(){return {state:'ready'}},snapshot({signal}){
  resolveStarted();return new Promise((_,reject)=>{
   signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'))},{once:true});
  });
 }};
 const t=await open({backend});
 const aborter=new AbortController();
 let fetchPromise;
 try{
  fetchPromise=fetch(t.bridge.url,{
   method:'POST',
   headers:{authorization:'Bearer '+t.token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},
   body:JSON.stringify({jsonrpc:'2.0',id:47,method:'tools/call',params:{name:'rdc_browser_snapshot',arguments:{}}}),
   signal:aborter.signal
  }).catch(()=>null);
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('MCP call did not start')),900))]);
  aborter.abort();
  await new Promise(resolve=>setTimeout(resolve,140));
  assert.equal(aborted,true,'disconnect should cancel backend work');
 }finally{aborter.abort();await fetchPromise;await t.client.close().catch(()=>{});await t.bridge.close()}
});
