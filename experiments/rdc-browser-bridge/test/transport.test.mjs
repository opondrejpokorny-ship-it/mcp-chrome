import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {createBridge} from '../src/server.mjs';
const backend={async status(){return {state:'ready'}},async snapshot(){return {origin:'http://127.0.0.1:9240',aria:'safe'}}};
const token=()=>randomBytes(32).toString('hex');

test('stop closes an authenticated but incomplete HTTP body without hanging',async()=>{
 const secret=token(),bridge=await createBridge({deviceId:'disposable-cube',token:secret,enabled:{rdc_browser_status:true},backend});
 const url=new URL(bridge.url);
 const socket=net.createConnection({host:'127.0.0.1',port:Number(url.port)});
 socket.on('error',()=>{});
 let closed=false;
 const closedPromise=new Promise(resolve=>socket.once('close',()=>{closed=true;resolve(true)}));
 let closing;
 try{
   await new Promise(resolve=>socket.once('connect',resolve));
   socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:'+url.port+'\r\nAuthorization: Bearer '+secret+'\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\n{');
   await new Promise(resolve=>setTimeout(resolve,80));
   closing=bridge.close();
   const outcome=await Promise.race([closedPromise.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),500))]);
   assert.equal(outcome,true,'bridge.close must close incomplete active socket within 500ms');
 }finally{
   socket.destroy();
   if(!closing)closing=bridge.close();
   await closing;
 }
 assert(closed);
});
