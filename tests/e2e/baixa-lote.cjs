// Teste de ponta a ponta: baixa em lote com leitura do PDF de comprovantes (OCR no navegador).
// Pré-requisito: Supabase local e app em http://127.0.0.1:3000, banco com a seed de demonstração.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const URL = 'http://127.0.0.1:54321';
const PUB = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SENHA = 'Demo-1234';
const PDF = path.join(__dirname, 'comprovantes-exemplo.pdf');

(async () => {
  // 1. Cria três pagamentos (fluxo C, já liberados) com os valores dos comprovantes
  const sb = createClient(URL, PUB, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email: 'financeiro@demo.local', password: SENHA });
  const { data: obra } = await sb.from('obras').select('id').eq('fluxo', 'C').limit(1).single();
  const valores = [
    ['A T Materiais Elétricos', 557.09],
    ['Xikuna Tubos e Conexões', 276.89],
    ['Casa Santana', 800.67],
  ];
  const ids = [];
  for (const [favorecido, valor] of valores) {
    const { data, error } = await sb.rpc('criar_pagamento', {
      p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: favorecido, p_descricao: 'Teste de baixa em lote',
      p_valor: valor, p_vencimento: '2026-11-04', p_forma_pagamento: 'pix',
    });
    if (error) throw new Error('criar: ' + error.message);
    ids.push(data);
  }
  const { data: criados } = await sb.from('pagamentos').select('id, numero, valor').in('id', ids);
  console.log('✔ 3 pagamentos criados:', criados.map((c) => `nº ${c.numero} (${c.valor})`).join(', '));

  // 2. Navegador: login, seleção, leitura do PDF e confirmação
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:3000/login');
  await page.fill('input[name=email]', 'financeiro@demo.local');
  await page.fill('input[name=senha]', SENHA);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);
  await page.goto('http://127.0.0.1:3000/pagamentos/baixa-lote');
  for (const c of criados) {
    await page.check(`input[aria-label="Selecionar nº ${c.numero}"]`);
  }
  await page.setInputFiles('input[type=file]', PDF);
  await page.click('button:has-text("Ler comprovantes")');
  await page.getByText(/página\(s\) lidas/).waitFor({ timeout: 300000 });
  await page.screenshot({ path: path.join(__dirname, '.saida', 'baixa-lote-revisao.png'), fullPage: true });
  const selects = await page.$$eval('table select', (s) => s.map((x) => x.options[x.selectedIndex].text));
  console.log('Ligações sugeridas:', selects.join(' | '));
  if (selects.some((t) => t.startsWith('Não anexar'))) throw new Error('alguma página ficou sem ligação: ' + selects.join(' | '));
  await page.click('button:has-text("anexar comprovantes")');
  await page.getByText(/pagamento\(s\) registrados/).waitFor({ timeout: 120000 });
  console.log('✔ Confirmação exibida');

  // 3. Confere no banco
  const { data: depois } = await sb.from('pagamentos').select('id, numero, status').in('id', ids);
  const { data: docs } = await sb.from('documentos').select('pagamento_id, tipo').in('pagamento_id', ids).eq('tipo', 'comprovante');
  const todosPagos = depois.every((p) => p.status === 'pago');
  const comprovantes = new Set(docs.map((d) => d.pagamento_id)).size;
  console.log(`Status: ${depois.map((p) => p.status).join(', ')}`);
  console.log(`Comprovantes anexados: ${comprovantes} de 3`);
  if (!todosPagos || comprovantes !== 3) throw new Error('resultado inesperado');
  console.log('✔ Baixa em lote com comprovantes separados conferida');
  await browser.close();
})().catch((e) => { console.error('✘ FALHOU:', e.message); process.exit(1); });
