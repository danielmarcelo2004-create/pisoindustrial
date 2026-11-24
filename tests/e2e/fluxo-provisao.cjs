// Fluxo da provisão sem sair da tela: "Lançar despesa" em Contas a pagar (e "Lançar" na Agenda) abre uma janela
// da provisão; "Lançar despesa agora" abre a nova despesa já preenchida e, ao salvar, a provisão vira "Lançada"
// sozinha. Inclui a regressão do botão que levava para a lista de Provisões (e não para a provisão) e da
// provisão que continuava em aberto ao lado da despesa já lançada. Também: "+ Novo" fornecedor na despesa.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };
async function entrar(b, email) {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  return p;
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
const foto = (p, nome) => p.screenshot({ path: path.join(DIR, `prov-${nome}.png`), fullPage: true });
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const pdf = path.join(DIR, 'boleto-provisao.pdf');
fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

(async () => {
  const b = await chromium.launch();
  const obraA = (await um(admin.from('obras').select('id, nome').eq('fluxo', 'A').order('nome').limit(1)))[0];
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const sup = (await um(admin.from('profiles').select('id').eq('perfil', 'suprimentos').limit(1).single())).id;
  const nova = async (descricao, created_by) => (await um(admin.from('provisoes').insert({ obra_id: obraA.id, descricao, vencimento: hoje, valor_estimado: 100, created_by }).select('id').single())).id;
  const pAgua = await nova('Conta de água (2/10)', fin);
  const pLuz = await nova('Conta de luz fictícia', fin);
  const pSup = await nova('Provisão do suprimentos', sup);
  const f = await entrar(b, 'financeiro@demo.local');

  await passo('regressão: "Lançar despesa" em Contas a pagar abre a janela da provisão (antes ia para a lista de Provisões)', async () => {
    await ir(f, `/pagamentos?periodo=hoje`);
    const linha = f.locator(`tr[data-linha="prov:${pAgua}"]`);
    await linha.getByRole('button', { name: 'Lançar despesa' }).click();
    const dlg = f.getByRole('dialog', { name: 'Lançar despesa da provisão' });
    await dlg.waitFor();
    const t = await dlg.innerText();
    confere(f.url().includes('/pagamentos') && /Conta de água \(2\/10\)/.test(t) && /R\$\s100,00/.test(t) && t.includes(obraA.nome), t.slice(0, 200));
    confere(await dlg.getByRole('link', { name: 'Lançar despesa agora' }).getAttribute('href') === `/pagamentos/novo?provisao=${pAgua}`, 'link do lançamento');
    await foto(f, 'janela');
  });

  await passo('"Ver em Provisões" abre a lista com a provisão destacada', async () => {
    const dlg = f.getByRole('dialog', { name: 'Lançar despesa da provisão' });
    await Promise.all([f.waitForURL(/\/provisoes\?prov=/), dlg.getByRole('link', { name: 'Ver em Provisões' }).click()]);
    const cls = await f.locator(`tr[data-provisao="${pAgua}"]`).getAttribute('class');
    confere(/outline-sky-400/.test(cls ?? ''), `classe: ${cls}`);
  });

  await passo('regressão: "Lançar despesa agora" abre a nova despesa preenchida e, ao salvar, a provisão vira "Lançada"', async () => {
    await ir(f, `/pagamentos?periodo=hoje`);
    await f.locator(`tr[data-linha="prov:${pAgua}"]`).getByRole('button', { name: 'Lançar despesa' }).click();
    await Promise.all([f.waitForURL(/\/pagamentos\/novo\?provisao=/), f.getByRole('link', { name: 'Lançar despesa agora' }).click()]);
    await f.waitForLoadState('networkidle');
    confere(await f.locator('[data-lancando-provisao]').count() === 1, 'sem aviso de lançamento da provisão');
    confere((await f.inputValue('input[name=descricao]')) === 'Conta de água (2/10)', 'descrição não veio');
    confere((await f.inputValue('select[name=obra_id]')) === obraA.id, 'centro de custo não veio');
    await f.fill('input[name=favorecido]', 'Companhia de Águas Fictícia');
    await f.fill('input[name=valor]', '112,40');
    await f.setInputFiles('input[name=boleto]', pdf);
    await f.click('button[aria-label="Categoria"]'); await f.locator('[role=option]').first().click();
    await foto(f, 'nova-despesa');
    await Promise.all([f.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/), f.click('button:has-text("Cadastrar e encaminhar")')]);
    const pagId = f.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const pr = await um(admin.from('provisoes').select('status, pagamento_id').eq('id', pAgua).single());
    confere(pr.status === 'convertida' && pr.pagamento_id === pagId, JSON.stringify(pr));
    await ir(f, `/pagamentos?periodo=hoje`);
    confere(await f.locator(`tr[data-linha="prov:${pAgua}"]`).count() === 0, 'provisão ainda aparece em Contas a pagar');
    await ir(f, `/provisoes?prov=${pAgua}`);
    confere(await f.locator(`tr[data-provisao="${pAgua}"] [data-despesa-da-provisao]`).count() === 1, 'Provisões sem o link da despesa');
    return `despesa ${pagId.slice(0, 8)} ligada à provisão`;
  });

  await passo('janela: "Já foi lançada" marca sem sair da tela', async () => {
    await ir(f, `/pagamentos?periodo=hoje`);
    await f.locator(`tr[data-linha="prov:${pLuz}"]`).getByRole('button', { name: 'Lançar despesa' }).click();
    await f.getByRole('button', { name: 'Já foi lançada: marcar como lançada' }).click();
    await f.getByRole('dialog', { name: 'Lançar despesa da provisão' }).waitFor({ state: 'detached' });
    await f.waitForLoadState('networkidle');
    confere(f.url().includes('/pagamentos'), f.url());
    confere((await um(admin.from('provisoes').select('status').eq('id', pLuz).single())).status === 'convertida', 'não marcou');
  });

  await passo('Agenda: provisão com "Lançar" abre a mesma janela', async () => {
    await ir(f, '/?ver=provisoes'); // as provisões ficam na aba "Provisões" do Painel
    const btn = f.getByRole('button', { name: 'Lançar', exact: true }).first();
    confere(await btn.count() === 1, 'sem botão Lançar na agenda');
    await btn.click();
    confere(await f.getByRole('dialog', { name: 'Lançar despesa da provisão' }).count() === 1, 'janela não abriu');
  });

  await passo('Suprimentos: lança a provisão que cadastrou; na de outro, a janela só informa', async () => {
    const s = await entrar(b, 'suprimentos@demo.local');
    await um(admin.from('provisoes').update({ created_by: fin }).eq('id', pLuz));
    const outra = await nova('Provisão do financeiro p/ sup', fin);
    await ir(s, `/pagamentos?periodo=hoje`);
    await s.locator(`tr[data-linha="prov:${pSup}"]`).getByRole('button', { name: 'Lançar despesa' }).click();
    confere(await s.getByRole('link', { name: 'Lançar despesa agora' }).count() === 1, 'sup não lança a própria');
    await s.getByRole('button', { name: 'Fechar' }).click();
    await s.locator(`tr[data-linha="prov:${outra}"]`).getByRole('button', { name: 'Lançar despesa' }).click();
    const t = await s.getByRole('dialog', { name: 'Lançar despesa da provisão' }).innerText();
    confere(/Quem lança é o Financeiro/.test(t) && (await s.getByRole('link', { name: 'Lançar despesa agora' }).count()) === 0, t.slice(0, 160));
  });

  await passo('Nova despesa: "+ Novo" fornecedor cadastra sem sair do formulário e já seleciona', async () => {
    await ir(f, '/pagamentos/novo');
    await f.fill('input[name=descricao]', 'Texto que não pode se perder');
    await f.getByRole('button', { name: '+ Novo' }).first().click();
    const dlg = f.getByRole('dialog', { name: 'Novo fornecedor' });
    await dlg.locator('input[aria-label="Nome do novo fornecedor"]').fill('Fornecedor Fictício Rápido');
    await dlg.getByRole('button', { name: 'Cadastrar' }).click();
    await dlg.waitFor({ state: 'detached' });
    const sel = await f.locator('select[name=fornecedor_id] option:checked').innerText();
    confere(sel === 'Fornecedor Fictício Rápido' && (await f.inputValue('input[name=descricao]')) === 'Texto que não pode se perder', `selecionado: ${sel}`);
    confere((await um(admin.from('fornecedores').select('id').eq('nome', 'Fornecedor Fictício Rápido'))).length === 1, 'não gravou');
  });

  console.log(`\nFluxo da provisão: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
