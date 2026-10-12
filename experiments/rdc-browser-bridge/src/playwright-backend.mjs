// EXPERIMENT ONLY: caller must exclusively own a disposable Playwright page.
// Cancellation closes that page; never attach this adapter to a personal browser.
export function createPlaywrightReadOnlyBackend({page,allowedOrigins}){
 if(!page||typeof page.url!=='function'||typeof page.on!=='function'||typeof page.off!=='function'||typeof page.frames!=='function'||!Array.isArray(allowedOrigins))throw new Error('Trusted disposable browser and allowlist required');
 const allowed=new Set(allowedOrigins);
 let generation=0;
 let disposed=false;
 const events=['framenavigated','frameattached','framedetached'];
 const onFrameChange=()=>{generation++};
 for(const event of events)page.on(event,onFrameChange);
 const current=()=>{try{const u=new URL(page.url());return allowed.has(u.origin)?u.origin:null}catch{return null}};
 const cancelled=()=>new Error('Browser observation cancelled');
 return {
  async status({signal}={}){
   if(disposed||signal?.aborted)throw cancelled();
   return {state:!page.isClosed()&&current()?'ready':'unavailable',backend:'playwright-isolated'};
  },
  async snapshot({signal}={}){
   if(disposed||signal?.aborted)throw cancelled();
   const startedGeneration=generation;
   const origin=current();
   if(page.isClosed()||!origin)throw new Error('Target outside trusted scope');
   const mainFrame=page.mainFrame();
   const framesAllowed=()=>page.frames().every(frame=>{
    if(frame===mainFrame)return current()===origin;
    try{return allowed.has(new URL(frame.url()).origin)}catch{return false}
   });
   let removeAbort=()=>{};
   let didAbort=false;
   const interruption=new Promise((_,reject)=>{
    const onAbort=()=>{
     didAbort=true;
     // Closing the exclusively owned disposable page interrupts underlying Playwright work.
     if(!page.isClosed()&&typeof page.close==='function'){
      try{void Promise.resolve(page.close({runBeforeUnload:false})).catch(()=>{})}catch{}
     }
     reject(cancelled());
    };
    if(signal){
     signal.addEventListener('abort',onAbort,{once:true});
     removeAbort=()=>signal.removeEventListener('abort',onAbort);
     if(signal.aborted)onAbort();
    }
   });
   try{
    if(!framesAllowed()||generation!==startedGeneration)throw new Error('Browser frame changed or outside scope');
    const operation=page.locator('body').ariaSnapshot({timeout:4000});
    const aria=signal?await Promise.race([operation,interruption]):await operation;
    if(didAbort||signal?.aborted||generation!==startedGeneration||current()!==origin||!framesAllowed())throw new Error('Browser frame changed during observation');
    return {origin,aria};
   }finally{removeAbort()}
  },
  dispose(){
   if(disposed)return;
   disposed=true;
   for(const event of events)page.off(event,onFrameChange);
  }
 };
}
