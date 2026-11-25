const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:390,height:900}})).newPage();
await p.goto('http://127.0.0.1:3000/login');await p.fill('input[name=email]','financeiro@demo.local');await p.fill('input[name=senha]','Demo-1234');await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login')),p.click('button:has-text("Entrar")')]);
await p.goto('http://127.0.0.1:3000/pagamentos/fd1286e7-8e83-4b60-a6ab-4126a0ab3dde');await p.waitForLoadState('networkidle');
console.log(await p.evaluate(()=>[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>392).slice(0,6).map(e=>e.tagName+'.'+String(e.className).slice(0,60)+' '+Math.round(e.getBoundingClientRect().right)+' '+(e.textContent||'').slice(0,20)).join('\n')));
await b.close();})();
