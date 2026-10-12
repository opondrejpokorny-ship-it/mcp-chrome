import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPlaywrightReadOnlyBackend } from '../src/playwright-backend.mjs';
const a='http://127.0.0.1:9240';
class FakePage extends EventEmitter {
 constructor(mutate){super();this.location=a;this.mutate=mutate;this.root={};}
 url(){return this.location}
 isClosed(){return false}
 mainFrame(){return this.root}
 frames(){return [this.root]}
 locator(selector){
  assert.equal(selector,'body');
  return {ariaSnapshot:async()=>{
   await this.mutate?.(this);
   return '- text: PRIVATE_TEST_MARKER';
  }};
 }
}
test('snapshot refuses A to B to A navigation during accessibility observation',async()=>{
 const page=new FakePage(async(p)=>{
  p.location='https://forbidden.invalid';
  p.emit('framenavigated',p.root);
  p.location=a;
  p.emit('framenavigated',p.root);
 });
 const backend=createPlaywrightReadOnlyBackend({page,allowedOrigins:[a]});
 await assert.rejects(backend.snapshot(),/changed|navigation|scope/i);
});
test('snapshot refuses same-origin document replacement during observation',async()=>{
 const page=new FakePage(async(p)=>p.emit('framenavigated',p.root));
 const backend=createPlaywrightReadOnlyBackend({page,allowedOrigins:[a]});
 await assert.rejects(backend.snapshot(),/changed|navigation|scope/i);
});
test('snapshot without navigation succeeds',async()=>{
 const page=new FakePage();
 const backend=createPlaywrightReadOnlyBackend({page,allowedOrigins:[a]});
 assert.deepEqual(await backend.snapshot(),{origin:a,aria:'- text: PRIVATE_TEST_MARKER'});
});
