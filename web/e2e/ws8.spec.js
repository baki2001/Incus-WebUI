const {chromium,devices}=require('playwright');
const fs=require('fs');
const BASE=process.env.BASE||'https://127.0.0.1:8508', tag=process.argv[2]||'before';
const pages=['/','/instances','/instances/local/app1','/instances/local/app1/terminal','/instances/local/app1/logs','/images','/storage','/storage/volumes','/networks','/profiles','/projects','/operations','/warnings','/settings','/hosts/local','/networks/acls'];
(async()=>{
 const b=await chromium.launch();
 const st='/tmp/ws8-state.json';
 if(!fs.existsSync(st)){const c=await b.newContext({ignoreHTTPSErrors:true});const p=await c.newPage();await p.goto(BASE);await p.waitForTimeout(1500);await p.fill('#u','admin');await p.fill('#p','review-pass-2026');await p.keyboard.press('Enter');await p.waitForTimeout(2500);await c.storageState({path:st});await c.close();}
 for(const dn of ['iPhone 13','Pixel 5']){
  const c=await b.newContext({...devices[dn],ignoreHTTPSErrors:true,storageState:st});
  const p=await c.newPage();
  for(const u of pages){await p.goto(BASE+u);await p.waitForTimeout(1200);
   const r=await p.evaluate(()=>{const w=document.documentElement.clientWidth;const bad=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>w+1&&!e.closest('.tw,.views,.tabs,.fbar,.set-nav,pre,.side,.scrim')}).slice(0,4).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right));
    const small=[...document.querySelectorAll('button,.btn,a.ni,.seg button,.chip-b,.chip-x,.tabs button')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.height<40&&getComputedStyle(e).visibility!='hidden'}).length;
    const inv=[...document.querySelectorAll('.qa')].filter(e=>getComputedStyle(e).opacity==0).length;
    return {sw:document.documentElement.scrollWidth,w,bad,small,invisibleQa:inv}});
   console.log(dn,u,JSON.stringify(r));
   if(dn=='iPhone 13')await p.screenshot({path:`/tmp/ws8-${tag}-${u.replace(/\//g,'_')||'_'}.png`});
  }
  await c.close();
 }
 await b.close();
})();
