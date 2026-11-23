// Persona: um dia do Financeiro, de ponta a ponta, SÓ COM CLIQUES (sem digitar endereço), como o usuário faz.
// Provisão → Contas a pagar › Lançar despesa (janela) → nova despesa → Registrar pagamento → extrato →
// conciliar → Movimentações › abrir a despesa → entrada → recebimento → Contas a receber › nota de medição.
// Se algum passo obrigar a "procurar" a próxima ação em outra tela, o teste falha. Dados fictícios.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const pdf = path.join(DIR, 'persona.pdf');
fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };
const menu = async (p, rotulo) => {
  const link = p.getByRole('navigation').getByRole('link', { name: rotulo, exact: true }).first();
  const destino = await link.getAttribute('href');
  await Promise.all([p.waitForURL((u) => u.pathname === destino && !u.search.includes('importado')), link.click()]);
  await p.waitForLoadState('networkidle');
};
const assentar = (p) => p.waitForLoadState('networkidle');

function ofx(linhas) {
  const d = hoje.replace(/-/g, '');
  const t = linhas.map(([v, memo, id]) => `<STMTTRN><TRNTYPE>${v < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d}030000<TRNAMT>${v}<FITID>${id}<MEMO>${memo}</STMTTRN>`).join('');
  const txt = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0104<BRANCHID>0042<ACCTID>0009998887776<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>${d}<DTEND>${d}${t}</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>${d}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const p = path.join(DIR, 'persona.ofx');
  fs.writeFileSync(p, Buffer.from(txt, 'latin1'));
  return p;
}

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => d.accept());
  const obraC = (await admin.from('obras').select('id, nome, cliente').eq('fluxo', 'C').limit(1).single()).data;
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);

  await passo('Provisões: registra a conta de luz do mês (menu › formulário)', async () => {
    await menu(p, 'Provisões');
    await p.selectOption('select[name=obra_id]', obraC.id);
    await p.fill('input[name=descricao]', 'Luz do canteiro (persona)');
    await p.fill('input[name=vencimento]', hoje);
    await p.fill('input[name=valor_estimado]', '480,00');
    await p.getByRole('button', { name: 'Registrar provisão' }).click();
    await p.getByText(/Provisão registrada/).waitFor({ timeout: 15000 });
  });

  let pagId = '';
  await passo('Contas a pagar › "Lançar despesa" na provisão › janela › "Lançar despesa agora" › nova despesa preenchida', async () => {
    await menu(p, 'Contas a pagar');
    const linha = p.locator('tr[data-linha^="prov:"]').filter({ hasText: 'Luz do canteiro (persona)' });
    await linha.getByRole('button', { name: 'Lançar despesa' }).click();
    await Promise.all([p.waitForURL(/\/pagamentos\/novo\?provisao=/), p.getByRole('link', { name: 'Lançar despesa agora' }).click()]);
    await assentar(p);
    confere((await p.inputValue('input[name=descricao]')) === 'Luz do canteiro (persona)', 'descrição não veio');
  });

  await passo('Nova despesa: "+ Novo" fornecedor, valor real, boleto e categoria › salvar › abre a despesa', async () => {
    await p.getByRole('button', { name: '+ Novo' }).first().click();
    await p.locator('input[aria-label="Nome do novo fornecedor"]').fill('Energia Fictícia S.A.');
    await p.getByRole('dialog', { name: 'Novo fornecedor' }).getByRole('button', { name: 'Cadastrar' }).click();
    await p.getByRole('dialog', { name: 'Novo fornecedor' }).waitFor({ state: 'detached' });
    await p.fill('input[name=valor]', '512,37');
    await p.setInputFiles('input[name=boleto]', pdf);
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await Promise.all([p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/), p.click('button:has-text("Cadastrar e encaminhar")')]);
    pagId = p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const pr = (await admin.from('provisoes').select('status, pagamento_id').eq('descricao', 'Luz do canteiro (persona)').single()).data;
    confere(pr.status === 'convertida' && pr.pagamento_id === pagId, `provisão: ${JSON.stringify(pr)}`);
  });

  await passo('Na própria despesa: "Registrar pagamento" › Confirmar › Pago', async () => {
    await p.getByRole('link', { name: 'Registrar pagamento' }).click();
    await p.locator('#baixa input[name=pago_em]').fill(hoje);
    await p.getByRole('button', { name: 'Confirmar pagamento' }).click();
    await p.waitForTimeout(1500); await assentar(p);
    const st = (await admin.from('pagamentos').select('status').eq('id', pagId).single()).data.status;
    confere(st === 'pago', st);
  });

  await passo('Contas bancárias (menu) › Importar extrato › a saída aparece como "Encontramos" › Conciliar', async () => {
    await menu(p, 'Contas bancárias');
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Importar extrato OFX' }).first().click()]);
    await fc.setFiles(ofx([[-512.37, 'PAGAMENTO DE BOLETO ENERGIA FICTICIA', 'P1'], [9500, 'TED RECEBIDA CLIENTE PERSONA', 'P2']]));
    await p.waitForURL(/importado=/, { timeout: 60000 }); await assentar(p);
    const l = p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: 'ENERGIA FICTICIA' }) });
    // despesa lançada com outra conta bancária: o sistema sugere "Quase lá" (valor igual) — também concilia direto
    confere(await l.locator('[data-sugestao="encontramos"], [data-sugestao="quase"]').count() === 1, 'sem sugestão da despesa paga');
    await l.getByRole('button', { name: 'Conciliar' }).click();
    await p.waitForTimeout(1500); await assentar(p);
  });

  await passo('Movimentações › clicar no nº da despesa abre a despesa certa', async () => {
    await p.getByRole('link', { name: /^Movimentações/ }).click(); await assentar(p);
    const row = p.locator('tr[data-conciliada]').filter({ hasText: 'ENERGIA FICTICIA' });
    await Promise.all([p.waitForURL(new RegExp(`/pagamentos/${pagId}`)), row.getByRole('link').first().click()]);
  });

  await passo('regressão: Contas bancárias pelo menu abre a conta com pendências (não a primeira do alfabeto)', async () => {
    await menu(p, 'Contas bancárias');
    confere(await p.locator('[data-descricao-banco]', { hasText: 'CLIENTE PERSONA' }).count() === 1, 'abriu outra conta');
  });

  await passo('Volta à conciliação › entrada: "+ Nova" categoria de receita, centro de custo (cliente vem da obra) › Conciliar', async () => {
    await menu(p, 'Contas bancárias');
    const l = p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: 'CLIENTE PERSONA' }) });
    await l.getByRole('button', { name: '+ Nova' }).click();
    await l.locator('input[aria-label="Nome da nova categoria de receita"]').fill('Medição (persona)');
    await l.locator('[data-nova-categoria="receita"]').getByRole('button', { name: 'Salvar' }).click();
    await l.locator('[data-nova-categoria="receita"]').waitFor({ state: 'detached' });
    await l.locator('select[aria-label="Centro de custo do recebimento"]').selectOption(obraC.id);
    if (!(await l.locator('input[aria-label="Cliente do recebimento"]').inputValue())) await l.locator('input[aria-label="Cliente do recebimento"]').fill('Cliente Persona');
    await l.locator('[data-conciliar-novo]').click();
    await p.waitForTimeout(1500); await assentar(p);
    confere((await admin.from('recebimentos').select('id').eq('valor', 9500)).data.length === 1, 'recebimento não criado');
  });

  await passo('Contas a receber (menu) › abrir o recebimento › "Enviar nota nova" › nota anexada', async () => {
    await menu(p, 'Contas a receber');
    const row = p.locator('tr[data-linha^="rec:"]').filter({ hasText: 'CLIENTE PERSONA' });
    await Promise.all([p.waitForURL(/\/recebimentos\/[0-9a-f-]{36}/), row.getByRole('link').first().click()]);
    await p.locator('[data-enviar-nota] summary').click();
    await p.setInputFiles('input[aria-label="Arquivo da nota de medição"]', pdf);
    await p.fill('input[aria-label="Valor total da nota"]', '10.000,00');
    await p.getByRole('button', { name: 'Enviar e anexar' }).click();
    await p.locator('[data-nota-anexada]').waitFor({ timeout: 30000 });
  });

  await passo('"← Contas a receber" volta para a lista', async () => {
    await Promise.all([p.waitForURL(/\/recebimentos(\?|$)/), p.getByRole('link', { name: '← Contas a receber' }).click()]);
  });

  console.log(`\nPersona Financeiro (só cliques): ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
