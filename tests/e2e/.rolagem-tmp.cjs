const { chromium } = require('playwright');
const urls = ['/','/pagamentos?periodo=todos','/pagamentos/baixar','/provisoes','/agenda','/recebimentos','/notas-medicao','/notas-contabeis','/usuarios','/fornecedores','/compras','/compras/ler-notas','/contas-bancarias?ver=conciliada','/contas-bancarias?ver=arquivada','/obras','/ops/nova','/fundos-fixos','/relatorios'];
(async()=>{const b=await chromium.launch();
for (const w of [1280,390]) { const p=await (await b.newContext({viewport:{width:w,height:900}})).newPage();
await p.goto('http://127.0.0.1:3000/login');await p.fill('input[name=email]','financeiro@demo.local');await p.fill('input[name=senha]','Demo-1234');await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login')),p.click('button:has-text("Entrar")')]);
for (const u of urls){await p.goto('http://127.0.0.1:3000'+u);await p.waitForLoadState('networkidle');await p.waitForTimeout(300);
const r=await p.evaluate(()=>[...document.querySelectorAll('main *')].filter(el=>el.scrollWidth>el.clientWidth+1&&['auto','scroll'].includes(getComputedStyle(el).overflowX)&&el.offsetParent).map(e=>e.tagName+' '+e.scrollWidth+'>'+e.clientWidth).concat(document.documentElement.scrollWidth>innerWidth+1?['PAGINA '+document.documentElement.scrollWidth]:[]));
if(r.length)console.log(w,u,r.join(' | '));}}
await b.close();})();
