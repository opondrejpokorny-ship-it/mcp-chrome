import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createBridge} from '../src/server.mjs';

const token=()=>randomBytes(32).toString('hex');
const backend={async status(){return {state:'ready',backend:'fixture'}},async snapshot(){return {origin:'http://127.0.0.1:9240',aria:'- button "Run"'}}};
async function fixture(options={}){
  const bearer=token();
  const bridge=await createBridge({deviceId:'cube-disposable',token:bearer,backend,enabled:{rdc_browser_status:true,rdc_browser_snapshot:true},allowedOrigins:['http://127.0.0.1:9240'],...options});
  return {bridge,bearer,url:bridge.url};
}
async function mcp(url,bearer){
  const client=new Client({name:'bridge-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer '+bearer}}}));
  return client;
}
test('no authorization callback means tool calls fail closed',async()=>{
  const f=await fixture();
  try{const c=await mcp(f.url,f.bearer);const listed=await c.listTools();assert.equal(listed.tools.length,2);
  const response=await c.callTool({name:'rdc_browser_status',arguments:{}});assert.equal(response.isError,true);await c.close();}finally{await f.bridge.close()}
});
test('explicit ALLOW enables scoped read-only status and snapshot',async()=>{
 const f=await fixture({authorize:({deviceId,tool})=>deviceId==='cube-disposable'&&['rdc_browser_status','rdc_browser_snapshot'].includes(tool)?'ALLOW':'DENY'});
 try{const c=await mcp(f.url,f.bearer);
 const status=await c.callTool({name:'rdc_browser_status',arguments:{}});assert.equal(status.isError??false,false);assert.match(status.content[0].text,/ready/);
 const snap=await c.callTool({name:'rdc_browser_snapshot',arguments:{}});assert.equal(snap.isError??false,false);assert.match(snap.content[0].text,/button/);await c.close();}finally{await f.bridge.close()}
});
test('tools absent when disabled',async()=>{
 const f=await fixture({enabled:{rdc_browser_status:true,rdc_browser_snapshot:false},authorize:()=> 'ALLOW'});
 try{const c=await mcp(f.url,f.bearer);const t=await c.listTools();assert.deepEqual(t.tools.map(x=>x.name),['rdc_browser_status']);await c.close();}finally{await f.bridge.close()}
});
test('approval-required never executes as allow',async()=>{
 let count=0;
 const f=await fixture({authorize:()=> 'REQUIRE_APPROVAL',backend:{async status(){count++;return {}},async snapshot(){count++;return {}}}});
 try{const c=await mcp(f.url,f.bearer);const x=await c.callTool({name:'rdc_browser_snapshot',arguments:{}});assert.equal(x.isError,true);assert.equal(count,0);await c.close();}finally{await f.bridge.close()}
});
test('bad token, origin and host are rejected before MCP',async()=>{
 const f=await fixture({authorize:()=> 'ALLOW'});
 const payload=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'probe',version:'1'}}});
 try{
 const cases=[{headers:{authorization:'Bearer wrong'},expected:401},{headers:{authorization:'Bearer '+f.bearer,origin:'https://evil.invalid'},expected:403}];
 for(const x of cases){const r=await fetch(f.url,{method:'POST',headers:{'content-type':'application/json',...x.headers},body:payload});assert.equal(r.status,x.expected);assert.doesNotMatch(await r.text(),new RegExp(f.bearer));}
 }finally{await f.bridge.close()}
});
test('reject oversized and malformed requests before execution',async()=>{
 let count=0;const f=await fixture({authorize:()=> 'ALLOW',backend:{async status(){count++;return {}},async snapshot(){count++;return {}}}});
 try{
 const r=await fetch(f.url,{method:'POST',headers:{authorization:'Bearer '+f.bearer,'content-type':'application/json'},body:'{' });assert.equal(r.status,400);
 const big=await fetch(f.url,{method:'POST',headers:{authorization:'Bearer '+f.bearer,'content-type':'application/json'},body:JSON.stringify({hello:'A'.repeat(40000)})});assert.equal(big.status,413);
 assert.equal(count,0);
 }finally{await f.bridge.close()}
});

test('HTTP Host spoofing via raw socket is blocked',async()=>{
 const f=await fixture({authorize:()=> 'ALLOW'});
 try{
  const result=await new Promise((resolve,reject)=>{
   const u=new URL(f.url);
   const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'POST',headers:{host:'untrusted.invalid','content-type':'application/json',authorization:'Bearer '+f.bearer}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
   req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}));
  });
  assert.equal(result,403);
 }finally{await f.bridge.close()}
});
test('disallowed origin snapshot fails closed with no content disclosure',async()=>{
 const f=await fixture({authorize:()=> 'ALLOW',backend:{async status(){return {state:'ready'}},async snapshot(){return {origin:'https://private.example',aria:'SECRET_DUMMY'}}}});
 try{const c=await mcp(f.url,f.bearer);const response=await c.callTool({name:'rdc_browser_snapshot',arguments:{}});assert.equal(response.isError,true);assert.doesNotMatch(JSON.stringify(response),/SECRET_DUMMY/);await c.close()}finally{await f.bridge.close()}
});
test('unknown policy response and thrown authorization fail closed',async()=>{
 for(const decide of [()=>'UNKNOWN',()=>{throw Error('private policy details')}]) {
  let invoked=0;const f=await fixture({authorize:decide,backend:{async status(){invoked++;return {state:'ready'}},async snapshot(){invoked++;return {aria:'hello'}}}});
  try{const c=await mcp(f.url,f.bearer);const r=await c.callTool({name:'rdc_browser_status',arguments:{}});assert.equal(r.isError,true);assert.equal(invoked,0);assert.doesNotMatch(JSON.stringify(r),/private policy details/);await c.close()}finally{await f.bridge.close()}
 }
});

test('browser capabilities disabled by default, invalid toggles rejected',async()=>{
 const key=token();
 const b=await createBridge({deviceId:'cube-disposable',token:key,backend,authorize:()=> 'ALLOW',allowedOrigins:['http://127.0.0.1:9240']});
 try{const c=await mcp(b.url,key);assert.deepEqual((await c.listTools()).tools,[]);await c.close()}finally{await b.close()}
 for(const enabled of [{rdc_browser_snapshot:'true'},{rdc_browser_cdp:true},null]){
  await assert.rejects(createBridge({deviceId:'cube-disposable',token:token(),backend,enabled}),/Invalid browser capability configuration/);
 }
});
test('invalid explicit authorization is not executed and cannot expose errors',async()=>{
 let observed=0;
 const f=await fixture({authorize:()=>null,backend:{async status(){observed++;return {state:'ready'}},async snapshot(){observed++;return {aria:'fake'}}}});
 try{const c=await mcp(f.url,f.bearer);const r=await c.callTool({name:'rdc_browser_status',arguments:{}});assert.equal(r.isError,true);assert.equal(observed,0);await c.close()}finally{await f.bridge.close()}
});

test('snapshot is bounded even for large allowed content',async()=>{
 const f=await fixture({authorize:()=> 'ALLOW',backend:{async status(){return {state:'ready'}},async snapshot(){return {origin:'http://127.0.0.1:9240',aria:'Z'.repeat(20000)}}}});
 try{const c=await mcp(f.url,f.bearer);const r=await c.callTool({name:'rdc_browser_snapshot',arguments:{}});const v=JSON.parse(r.content[0].text);assert.equal(v.aria.length,8192);assert.equal(v.truncated,true);await c.close()}finally{await f.bridge.close()}
});
test('missing or invalid trusted bridge identity/token rejects startup',async()=>{
 for(const args of [{deviceId:'',token:token(),backend},{deviceId:'cube-disposable',token:'short',backend},{deviceId:'cube-disposable',token:token(),backend:{}}]){
  await assert.rejects(createBridge(args));
 }
});

test('concurrent snapshots do not execute overlapping browser observations',async()=>{
 let active=0,peak=0,calls=0;
 const f=await fixture({authorize:()=> 'ALLOW',backend:{async status(){return {state:'ready'}},async snapshot(){calls++;active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,120));return {origin:'http://127.0.0.1:9240',aria:'- button "test"'}}finally{active--}}}});
 try{
  const c=await mcp(f.url,f.bearer);
  const results=await Promise.all(Array.from({length:5},()=>c.callTool({name:'rdc_browser_snapshot',arguments:{}})));
  assert.equal(peak,1,'browser observation must be serialized per bound session');
  assert.equal(calls,1,'overlapping snapshots must be refused rather than queued unbounded');
  assert.equal(results.filter(x=>!x.isError).length,1);
  await c.close();
 }finally{await f.bridge.close()}
});
test('hung trusted authorization eventually denies without touching backend',async()=>{
 let called=0;
 const f=await fixture({authorize:()=>new Promise(()=>{}),backend:{async status(){called++;return {state:'ready'}},async snapshot(){called++;return {origin:'http://127.0.0.1:9240',aria:'safe'}}}});
 try{
  const c=await mcp(f.url,f.bearer);
  const r=await Promise.race([c.callTool({name:'rdc_browser_status',arguments:{}}),new Promise((_,reject)=>setTimeout(()=>reject(Error('unbounded trusted authorization')),3200))]);
  assert.equal(r.isError,true);
  assert.equal(called,0);
  await c.close();
 }finally{await f.bridge.close()}
});

test('unresponsive backend operation returns bounded error and does not leak content',async()=>{
 let invoked=0;
 const f=await fixture({authorize:()=> 'ALLOW',backend:{async status(){return {state:'ready'}},async snapshot(){invoked++;return new Promise(()=>{})}}});
 try{
  const c=await mcp(f.url,f.bearer);
  const timed=await Promise.race([
   c.callTool({name:'rdc_browser_snapshot',arguments:{}}),
   new Promise((_,reject)=>setTimeout(()=>reject(Error('backend ran beyond deadline')),6200))
  ]);
  assert.equal(timed.isError,true);
  assert.equal(invoked,1);
  const health=await c.callTool({name:'rdc_browser_status',arguments:{}});
  assert.equal(JSON.parse(health.content[0].text).state,'unavailable','terminal snapshot timeout must degrade browser status');
  const again=await c.callTool({name:'rdc_browser_snapshot',arguments:{}});
  assert.equal(again.isError,true);
  assert.equal(invoked,1,'stuck operation must not start a second observation');
  await c.close();
 }finally{await f.bridge.close()}
});
