// Contas a pagar (e outras listas) não têm rolagem lateral: a tabela cabe em 1280px e vira cartões em 390px. Dados fictícios.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:3000';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const b = await chromium.launch();
  for (const largura of [1280, 390]) {
    const p = await (await b.newContext({ viewport: { width: largura, height: 900 }, deviceScaleFactor: 2 })).newPage();
    p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
    await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
    for (const url of ['/pagamentos?periodo=todos', '/provisoes', '/notas-medicao', '/recebimentos']) {
      await passo(`regressão: ${url} sem rolagem lateral em ${largura}px`, async () => {
        await p.goto(BASE + url); await p.waitForLoadState('networkidle');
        const r = await p.evaluate(() => {
          const wrappers = [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX));
          return { pagina: document.documentElement.scrollWidth - innerWidth, tabelas: wrappers.map((w) => `${w.tagName}.${String(w.className).slice(0, 40)} ${w.scrollWidth}>${w.clientWidth}`) };
        });
        confere(r.pagina <= 1, `a página passa ${r.pagina}px da tela`);
        confere(r.tabelas.length === 0, `rolagem lateral em: ${r.tabelas.join(' | ')}`);
        if (url.startsWith('/pagamentos')) await p.screenshot({ path: path.join(DIR, `contas-pagar-${largura}.png`) });
      });
    }
  }
  console.log(`\nSem rolagem lateral: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
