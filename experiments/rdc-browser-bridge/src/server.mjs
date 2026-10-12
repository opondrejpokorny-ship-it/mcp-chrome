import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const TOOL_NAMES=['rdc_browser_status','rdc_browser_snapshot'];
const MAX_REQUEST_BYTES=16384;
const MAX_SNAPSHOT_CHARS=8192;
const MAX_ACTIVE_REQUESTS=8;
const MAX_OPEN_SOCKETS=16;
const AUTHORIZATION_TIMEOUT_MS=2000;
const OBSERVATION_TIMEOUT_MS=5000;
const loopback='127.0.0.1';
async function withDeadline(work,ms,parentSignal){
 const controller=new AbortController();
 const onParentAbort=()=>controller.abort();
 if(parentSignal?.aborted)controller.abort();
 else parentSignal?.addEventListener('abort',onParentAbort,{once:true});
 let timer;
 try{
  return await Promise.race([
   Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('operation_cancelled');return work(controller.signal)}),
   new Promise((_,reject)=>{
    const abort=()=>reject(new Error('operation_cancelled'));
    controller.signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{reject(new Error('operation_timeout'));controller.abort(new Error('operation_timeout'))},ms);
    if(controller.signal.aborted)abort();
   })
  ]);
 }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',onParentAbort)}
}

function errorBody(response,code){
 if(response.headersSent){response.end();return}
 response.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 response.end(JSON.stringify({error:code===401?'unauthorized':code===413?'request_too_large':'request_rejected'}));
}
function secureBearer(received,expected){
 if(typeof received!=='string'||!received.startsWith('Bearer '))return false;
 const a=Buffer.from(received.slice(7),'utf8'),b=Buffer.from(expected,'utf8');
 return a.length===b.length&&timingSafeEqual(a,b);
}
async function readJson(req){
 const size=Number(req.headers['content-length']);
 if(Number.isFinite(size)&&size>MAX_REQUEST_BYTES){const e=new Error('too_large');e.status=413;throw e}
 let sizeRead=0;const chunks=[];
 for await (const chunk of req){
  sizeRead+=chunk.length;
  if(sizeRead>MAX_REQUEST_BYTES){const e=new Error('too_large');e.status=413;throw e}
  chunks.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
 catch{const e=new Error('invalid_json');e.status=400;throw e}
}
const safeString=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const reply=(value)=>({content:[{type:'text',text:JSON.stringify(value)}]});
const denied=()=>({isError:true,content:[{type:'text',text:'Access denied by RDC browser policy'}]});
export async function createBridge({deviceId,token,backend,authorize=()=> 'DENY',enabled={},allowedOrigins=[]}={}){
 if(typeof deviceId!=='string'||deviceId.length<3||deviceId.length>128)throw new Error('Trusted device identity required');
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/i.test(token))throw new Error('Trusted ephemeral 256-bit token required');
 if(typeof authorize!=='function')throw new Error('Policy callback must be trusted');
 if(!backend||typeof backend.status!=='function'||typeof backend.snapshot!=='function')throw new Error('Read-only backend required');
 if(!Array.isArray(allowedOrigins)||allowedOrigins.some(x=>typeof x!=='string'||x.length>200))throw new Error('Invalid trusted allowlist');
 const trustedOrigins=new Set(allowedOrigins.map(x=>{const url=new URL(x);if(url.origin!==x||!['http:','https:'].includes(url.protocol))throw new Error('Origin must be exact');return x}));
 if(!enabled||typeof enabled!=='object'||Array.isArray(enabled)||Object.keys(enabled).some(x=>!TOOL_NAMES.includes(x)||typeof enabled[x]!=='boolean'))throw new Error('Invalid browser capability configuration');
 const tools=Object.fromEntries(TOOL_NAMES.map(x=>[x,enabled[x]===true]));
 let snapshotBusy=false;
 let snapshotUnhealthy=false;
 let activeRequests=0;
 const activeControllers=new Set();
 const sockets=new Set();
 function createMcp(requestSignal){
  const server=new McpServer({name:'rdc-browser-readonly-poc',version:'0.0.1'});
  async function gate(tool,handler){
   let result='DENY';
   try{result=await withDeadline((signal)=>authorize(Object.freeze({deviceId,tool,action:'READ',signal})),AUTHORIZATION_TIMEOUT_MS,requestSignal)}catch{return denied()}
   if(result!=='ALLOW'||requestSignal?.aborted)return denied();
   try{return reply(await withDeadline(handler,OBSERVATION_TIMEOUT_MS,requestSignal))}catch(e){
    if(tool==='rdc_browser_snapshot'&&['operation_timeout','operation_cancelled'].includes(e?.message))snapshotUnhealthy=true;
    return {isError:true,content:[{type:'text',text:'Browser observation unavailable or outside allowed scope'}]};
   }
  }
  if(tools.rdc_browser_status)server.registerTool('rdc_browser_status',{description:'Check prebound test browser session availability (read only)',inputSchema:{},annotations:{readOnlyHint:true}},async()=>gate('rdc_browser_status',async(signal)=>{
   const x=await backend.status({signal});
   return {state:!snapshotUnhealthy&&x?.state==='ready'?'ready':'unavailable',backend:safeString(x?.backend,40),deviceId};
  }));
  if(tools.rdc_browser_snapshot)server.registerTool('rdc_browser_snapshot',{description:'Observe prebound allowlisted test page accessibility (read only)',inputSchema:{},annotations:{readOnlyHint:true}},async()=>gate('rdc_browser_snapshot',async(signal)=>{
   if(snapshotUnhealthy||snapshotBusy)throw new Error('snapshot unavailable');
   snapshotBusy=true;
   const operation=Promise.resolve().then(()=>backend.snapshot({signal}));
   void operation.then(()=>{snapshotBusy=false},()=>{snapshotBusy=false});
   const value=await operation;
   if(!value||!trustedOrigins.has(value.origin))throw new Error('Not allowlisted');
   const aria=safeString(value.aria,MAX_SNAPSHOT_CHARS);
   return {origin:value.origin,aria,truncated:typeof value.aria==='string'&&value.aria.length>MAX_SNAPSHOT_CHARS,deviceId};
  }));
  if(!tools.rdc_browser_status&&!tools.rdc_browser_snapshot){
   server.server.registerCapabilities({tools:{}});
   server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
  }
  return server;
 }
 let port;
 const listener=http.createServer(async(req,res)=>{
  try{
   const exactHost=loopback+':'+port;
   if(req.headers.host!==exactHost)return errorBody(res,403);
   if(req.headers.origin)return errorBody(res,403);
   if(!secureBearer(req.headers.authorization,token))return errorBody(res,401);
   if(req.method!=='POST'||req.url!=='/mcp')return errorBody(res,405);
   const ctype=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
   if(ctype!=='application/json')return errorBody(res,415);
   if(activeRequests>=MAX_ACTIVE_REQUESTS)return errorBody(res,429);
   activeRequests++;
   const controller=new AbortController();
   activeControllers.add(controller);
   try{
   let mcp,transport;
   let cleaned=false;
   const cleanup=()=>{
    if(cleaned)return;
    cleaned=true;
    controller.abort();
    void Promise.allSettled([transport?.close(),mcp?.close()]);
   };
   res.once('finish',cleanup);
   res.once('close',cleanup);
   try{
    const body=await readJson(req);
    if(!body||typeof body!=='object'||Array.isArray(body))return errorBody(res,400);
    mcp=createMcp(controller.signal);
    transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    await mcp.connect(transport);
    await transport.handleRequest(req,res,body);
   }finally{
    cleanup();
    res.off('finish',cleanup);
    res.off('close',cleanup);
   }
   }finally{
    controller.abort();
    activeControllers.delete(controller);
    activeRequests--;
   }
  }catch(e){if(!res.writableEnded)errorBody(res,e?.status??400)}
 });
 // Bound sockets before complete HTTP headers arrive; partial requests must not bypass admission.
 listener.maxConnections=MAX_OPEN_SOCKETS;
 listener.on('connection',socket=>{
  if(sockets.size>=MAX_OPEN_SOCKETS){socket.destroy();return}
  sockets.add(socket);
  socket.once('close',()=>sockets.delete(socket));
  socket.setTimeout(5000,()=>socket.destroy());
 });
 // Bound incomplete client requests and keep the shutdown path independent of their progress.
 listener.requestTimeout=5000;
 listener.headersTimeout=5000;
 listener.setTimeout(5000,(socket)=>socket.destroy());
 try{
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,loopback,resolve)});
  port=listener.address().port;
  const url='http://'+loopback+':'+port+'/mcp';
  let shutdown;
  return {url,close:()=>{
   if(shutdown)return shutdown;
   shutdown=new Promise((resolve,reject)=>{
    for(const controller of activeControllers)controller.abort();
    listener.close(e=>e?reject(e):resolve());
    for(const socket of sockets)socket.destroy();
    listener.closeAllConnections();
   }).finally(()=>backend.dispose?.());
   return shutdown;
  }};
 }catch(e){listener.close();throw e}
}
