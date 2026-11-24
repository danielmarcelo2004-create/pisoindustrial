// Conciliação "Quase lá" › "Ajustar valores ▾" (como no Conta Azul): usar o valor do extrato (diferença de centavos
// vira juros/desconto), informar valores adicionais, buscar mais lançamentos e criar novo pagamento. Dados fictícios.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const obra = await um(admin.from('obras').select('id, fluxo').eq('fluxo', 'C').limit(1).single());
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const conta = (await um(admin.from('contas_bancarias').insert({ nome: 'Conta ajuste', banco: '237', agencia: '1', conta: '424242', created_by: fin }).select('id').single())).id;
  const nova = async (favorecido, valor) => (await um(admin.from('pagamentos').insert({ obra_id: obra.id, favorecido, descricao: favorecido, valor, vencimento: hoje, forma_pagamento: 'boleto', fluxo: 'C', status: 'aguardando_pagamento', created_by: fin, conta_bancaria_id: conta }).select('id').single())).id;
  const pSeg = await nova('Akad Seguros Fictícia', 1185.14);
  const pEle = await nova('Elétrica Fictícia', 2234.55);
  const pDesc = await nova('Desconto Fictício', 1347.83);
  const imp = (await um(admin.from('extrato_importacoes').insert({ conta_id: conta, arquivo: 'ajuste.ofx', created_by: fin }).select('id').single())).id;
  await um(admin.from('extrato_linhas').insert([
    { conta_id: conta, importacao_id: imp, data: hoje, valor: -1185.15, tipo: 'DEBIT', descricao: 'PAG BOLETO AKAD SEGUROS', fitid: 'A1' },
    { conta_id: conta, importacao_id: imp, data: hoje, valor: -2279.40, tipo: 'DEBIT', descricao: 'PAG BOLETO ELETRICA', fitid: 'A2' },
    { conta_id: conta, importacao_id: imp, data: hoje, valor: -1342.00, tipo: 'DEBIT', descricao: 'PAG BOLETO DESCONTO', fitid: 'A3' },
  ]));
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);
  const abrir = async () => { await p.goto(`${BASE}/contas-bancarias?conta=${conta}`); await p.waitForLoadState('networkidle'); };
  const linha = (t) => p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: t }) }).first();

  await passo('"Quase lá" mostra "Ajustar valores ▾" com as 4 opções e "Editar"', async () => {
    await abrir();
    const l = linha('AKAD');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    const itens = await l.getByRole('menuitem').allInnerTexts();
    confere(itens.length === 4 && /Informar valores adicionais/.test(itens[0]) && /Usar valor do extrato/.test(itens[1]) && /Buscar mais/.test(itens[2]) && /Criar novo pagamento/.test(itens[3]), itens.join(' | '));
    confere(await l.getByRole('link', { name: 'Editar' }).count() === 1, 'sem Editar');
    await l.screenshot({ path: path.join(__dirname, '.saida', 'ajustar-valores.png') }).catch(() => {});
    await p.screenshot({ path: path.join(__dirname, '.saida', 'ajustar-valores-tela.png') });
  });

  await passo('"Usar valor do extrato": diferença de R$ 0,01 vira juros e a conta fica paga com o valor do banco', async () => {
    const l = linha('AKAD');
    await l.getByRole('menuitem', { name: /Usar valor do extrato/ }).click();
    await p.waitForTimeout(1500); await p.waitForLoadState('networkidle');
    const pg = await um(admin.from('pagamentos').select('status, valor_pago').eq('id', pSeg).single());
    confere(pg.status === 'pago' && Number(pg.valor_pago) === 1185.15, JSON.stringify(pg));
  });

  await passo('"Usar valor do extrato" com o banco pagando a menos: diferença vira desconto e quita', async () => {
    await abrir();
    const l = linha('DESCONTO');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    const txtMenu = await l.getByRole('menuitem', { name: /Usar valor do extrato/ }).innerText();
    confere(/desconto/.test(txtMenu), 'não diz desconto: ' + txtMenu.replace(/\s+/g, ' '));
    await l.getByRole('menuitem', { name: /Usar valor do extrato/ }).click();
    await p.waitForTimeout(1500); await p.waitForLoadState('networkidle');
    const pg = await um(admin.from('pagamentos').select('status, valor_pago').eq('id', pDesc).single());
    confere(pg.status === 'pago' && Number(pg.valor_pago) === 1342, JSON.stringify(pg));
  });

  await passo('"Informar valores adicionais" abre a conferência com a conta já marcada', async () => {
    await um(admin.from('pagamentos').insert({ obra_id: obra.id, favorecido: 'Outra Elétrica', descricao: 'x', valor: 2234.40, vencimento: hoje, forma_pagamento: 'boleto', fluxo: 'C', status: 'aguardando_pagamento', created_by: fin, conta_bancaria_id: conta }));
    await abrir();
    const l = linha('ELETRICA');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    await l.getByRole('menuitem', { name: /Informar valores adicionais/ }).click();
    const dlg = p.getByRole('dialog', { name: 'Buscar conta a pagar' });
    await dlg.waitFor();
    confere(await dlg.locator('li input[type=checkbox]:checked').count() === 1, 'conta não veio marcada');
    await p.keyboard.press('Escape');
  });

  await passo('"Criar novo pagamento" troca para o "Novo lançamento" com a descrição do banco', async () => {
    await abrir();
    const l = linha('ELETRICA');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    await l.getByRole('menuitem', { name: 'Criar novo pagamento' }).click();
    confere(/PAG BOLETO ELETRICA/.test(await l.locator('input[aria-label="Descrição do novo lançamento"]').inputValue()), 'não abriu o novo lançamento');
  });

  console.log(`\nAjustar valores: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
