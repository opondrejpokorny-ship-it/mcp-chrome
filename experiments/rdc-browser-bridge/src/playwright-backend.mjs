// Experimental trusted backend. Bind only a disposable page; never attach to a user's Chrome profile.
export function createPlaywrightReadOnlyBackend({page,allowedOrigins}){
 if(!page||typeof page.url!=='function'||!Array.isArray(allowedOrigins))throw new Error('Trusted browser context and allowlist required');
 const allowed=new Set(allowedOrigins);
 const current=()=>{try{const u=new URL(page.url());return allowed.has(u.origin)?u.origin:null}catch{return null}};
 return {
  async status(){return {state:!page.isClosed()&&current()?'ready':'unavailable',backend:'playwright-isolated'}},
  async snapshot(){
   const origin=current();
   if(page.isClosed()||!origin)throw new Error('Target outside trusted scope');
   const mainFrame=page.mainFrame();
   const framesAllowed=()=>page.frames().every(frame=>{
    if(frame===mainFrame)return current()===origin;
    try{return allowed.has(new URL(frame.url()).origin)}catch{return false}
   });
   let frameChanged=false;
   const onFrameChange=()=>{frameChanged=true};
   for(const event of ['framenavigated','frameattached','framedetached'])page.on(event,onFrameChange);
   try{
    if(!framesAllowed())throw new Error('Embedded frame outside trusted origin scope');
    const aria=await page.locator('body').ariaSnapshot({timeout:4000});
    if(frameChanged||current()!==origin||!framesAllowed())throw new Error('Target changed during observation');
    return {origin,aria};
   }finally{
    for(const event of ['framenavigated','frameattached','framedetached'])page.off(event,onFrameChange);
   }
  }
 };
}
