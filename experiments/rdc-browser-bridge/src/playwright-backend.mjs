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
   const frame=page.mainFrame();
   let navigationObserved=false;
   const onNavigation=(changedFrame)=>{if(changedFrame===frame)navigationObserved=true};
   page.on('framenavigated',onNavigation);
   try{
    const aria=await page.locator('body').ariaSnapshot({timeout:4000});
    if(navigationObserved||current()!==origin)throw new Error('Target changed during observation');
    return {origin,aria};
   }finally{page.off('framenavigated',onNavigation)}
  }
 };
}
