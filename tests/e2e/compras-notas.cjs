// Inteligência de Compras lendo as notas anexadas nas despesas. Regressão: a nota fiscal em PDF (DANFE)
// anexada na nova despesa não entrava na análise (só o XML era lido). Dados fictícios (tests/exemplos).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const DANFE = path.join(__dirname, '..', 'exemplos', 'danfe-produto.pdf');
const IMG = path.join(__dirname, '.saida', 'nota-foto.png');
fs.mkdirSync(path.dirname(IMG), { recursive: true });
fs.writeFileSync(IMG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };

async function novaDespesa(p, descricao, nota) {
  await p.goto(BASE + '/pagamentos/novo');
  const obra = await p.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.value).value);
  await p.selectOption('select[name=obra_id]', obra);
  await p.fill('input[name=favorecido]', 'Aço Forte Distribuidora');
  await p.fill('input[name=descricao]', descricao);
  await p.fill('input[name=valor]', '1.000,00');
  await p.fill('input[name=vencimento]', new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10));
  await p.setInputFiles('input[name=nota_fiscal]', nota);
  await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
  await p.click('button:has-text("Cadastrar e encaminhar")');
  await p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 }).catch(async () => {
    await p.screenshot({ path: path.join(__dirname, '.saida', 'compras-erro.png'), fullPage: true });
    throw new Error('não salvou: ' + (await p.locator('[role=alert], .text-red-700, .bg-red-50').allInnerTexts()).join(' | ').slice(0, 200));
  });
  return p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
}

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => { console.log('  janela:', d.message().slice(0, 120)); d.accept(); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);

  await passo('regressão: DANFE em PDF anexado na nova despesa entra sozinho na Inteligência de Compras', async () => {
    const pag = await novaDespesa(p, 'Vergalhão (nota em PDF)', DANFE);
    const { data: doc } = await admin.from('documentos').select('id').eq('pagamento_id', pag).eq('tipo', 'nota_fiscal').single();
    const { data: nf } = await admin.from('nf_notas').select('id, numero, nf_itens(descricao, quantidade, valor_total)').eq('documento_id', doc.id).maybeSingle();
    confere(nf && nf.nf_itens.length === 1 && Number(nf.nf_itens[0].valor_total) === 1000, JSON.stringify(nf));
    await p.goto(BASE + '/compras'); await p.waitForLoadState('networkidle');
    confere(/Vergalh/i.test(await p.locator('main').innerText()), 'item não aparece na análise');
    return `${nf.nf_itens[0].descricao} · ${nf.nf_itens[0].quantidade} un`;
  });

  await passo('nota em imagem (não legível no servidor) aparece no aviso "ainda não entraram na análise"', async () => {
    await novaDespesa(p, 'Compra com foto da nota', IMG);
    await p.goto(BASE + '/compras'); await p.waitForLoadState('networkidle');
    const aviso = p.locator('[data-notas-nao-lidas]');
    confere(await aviso.count() === 1 && /nota\(s\) fiscal\(is\)/.test(await aviso.innerText()), 'sem aviso');
    await p.getByRole('button', { name: 'Ler automaticamente' }).click();
    await p.getByText(/nota\(s\) lida\(s\)/).waitFor({ timeout: 30000 });
    return (await p.getByText(/nota\(s\) lida\(s\)/).innerText()).slice(0, 160);
  });

  await passo('Inteligência de Compras aberta a engenheiro e administrador: só leitura, sem CNPJ, sem Excel nem leitura de notas', async () => {
    for (const email of ['engenheiro@demo.local', 'administrador@demo.local']) {
      const c = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      c.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
      await c.goto(BASE + '/login'); await c.fill('input[name=email]', email); await c.fill('input[name=senha]', 'Demo-1234');
      await Promise.all([c.waitForURL((u) => !u.pathname.startsWith('/login')), c.click('button:has-text("Entrar")')]);
      confere(await c.getByRole('link', { name: 'Inteligência de Compras' }).count() > 0, `${email}: sem o item no menu`);
      await c.goto(BASE + '/compras'); await c.waitForLoadState('networkidle');
      const t = await c.locator('main').innerText();
      confere(/Vergalh/i.test(t), `${email}: não vê os preços de todas as obras`);
      confere(!/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(t), `${email}: o CNPJ do fornecedor apareceu`);
      confere(await c.getByRole('link', { name: 'Exportar para Excel' }).count() === 0 && await c.getByRole('link', { name: 'Ler notas (PDF)' }).count() === 0, `${email}: viu botões de Excel ou leitura de notas`);
      confere((await c.request.get(BASE + '/compras/exportar')).status() === 403, `${email}: a exportação não deveria abrir`);
      confere((await c.goto(BASE + '/compras/ler-notas')) && !c.url().includes('/compras/ler-notas'), `${email}: abriu a leitura de notas`);
    }
  });

  console.log(`\nCompras × notas das despesas: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
