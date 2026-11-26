// Exportações organizadas: Contas a pagar, Contas a receber e Relatórios saem em Excel arrumado (título, resumo, tabela,
// situação colorida, total) ou em PDF para imprimir (A4 paisagem, cabeçalho da empresa, rodapé com página). Botão "Imprimir"
// ao lado de "Exportar". Dados fictícios.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { lerXlsx, dadosDaTabela } = require('./_xlsx.cjs');

const BASE = 'http://127.0.0.1:3000';
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
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

async function textoDoPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  let t = '';
  for (let i = 1; i <= doc.numPages; i++) t += (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n';
  return { texto: t, paginas: doc.numPages };
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  const get = (url) => ctx.request.get(BASE + url);

  // Massa para várias páginas: 70 despesas com a mesma marca
  const marca = `Exp${Date.now() % 100000}`;
  const obra = (await um(admin.from('obras').select('id, fluxo').limit(1)))[0];
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  await um(admin.from('pagamentos').insert(Array.from({ length: 70 }, (_, i) => ({
    obra_id: obra.id, favorecido: `Fornecedor ${marca} ${i + 1}`, descricao: `Descrição longa da despesa ${i + 1} ${marca} com texto grande para quebrar linha na coluna`, valor: 100 + i + 0.35,
    vencimento: hoje, forma_pagamento: 'boleto', status: 'aguardando_pagamento', fluxo: obra.fluxo, created_by: fin,
  }))));

  await passo('botões "Exportar" e "Imprimir" lado a lado em Contas a pagar, Contas a receber e Relatórios (Imprimir abre o PDF em outra aba)', async () => {
    for (const url of ['/pagamentos?periodo=todos', '/recebimentos?periodo=todos', '/relatorios']) {
      await p.goto(BASE + url); await p.waitForLoadState('networkidle');
      const exp = p.locator('a[href*="/exportar?"]:not([href*="formato=pdf"])').first();
      const imp = p.getByRole('link', { name: 'Imprimir' });
      confere(await exp.count() === 1 && await imp.count() === 1, `${url}: faltam os botões`);
      confere(/formato=pdf/.test(await imp.getAttribute('href')) && await imp.getAttribute('target') === '_blank', `${url}: Imprimir sem PDF/nova aba`);
    }
  });

  await passo('Contas a pagar em Excel: título, resumo, cabeçalho, valores numéricos, situação colorida, total somando, filtro e cabeçalho fixo', async () => {
    const r = await get(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${marca}`);
    confere(r.status() === 200 && /spreadsheetml/.test(r.headers()['content-type']), `${r.status()} ${r.headers()['content-type']}`);
    confere(/\.xlsx"/.test(r.headers()['content-disposition']), 'sem nome .xlsx');
    const [aba] = await lerXlsx(await r.body());
    confere(aba.linhas[0].vals[0] === 'Contas a pagar', `título: ${aba.linhas[0].vals[0]}`);
    confere(aba.linhas.some((l) => /CONSTRUTORA/i.test(String(l.vals[0]))), 'sem a empresa no topo');
    confere(aba.linhas.some((l) => String(l.vals[0]).startsWith('Total do período')), 'sem o resumo');
    const t = dadosDaTabela(aba, 'Vencimento');
    confere(t.linhas.length === 70, `${t.linhas.length} linhas (esperado 70)`);
    const iVal = t.cabecalho.indexOf('Valor (R$)');
    confere(t.linhas.every((l) => typeof l[iVal] === 'number'), 'valor não é número');
    confere(Math.abs(t.linhas.reduce((s, l) => s + l[iVal], 0) - [...Array(70).keys()].reduce((s, i) => s + 100 + i + 0.35, 0)) < 0.01, 'soma diferente');
    // cabeçalho com fundo escuro, situação com cor, total com fórmula
    const cab = aba.linhas.find((l) => String(l.vals[0]) === 'Vencimento');
    confere(cab.cells.getCell(1).fill?.fgColor?.argb === 'FF1F3A5A', 'cabeçalho sem destaque');
    const iSit = t.cabecalho.indexOf('Situação');
    const primeira = aba.linhas[aba.linhas.indexOf(cab) + 1];
    const fonteSit = primeira.cells.getCell(iSit + 1).font;
    confere(/^● /.test(String(primeira.vals[iSit])) && !!fonteSit?.color?.argb, 'situação sem marcador/cor');
    const total = aba.linhas.find((l) => String(l.vals[0]) === 'Total');
    confere(total && typeof total.cells.getCell(iVal + 1).value === 'object' && /SUBTOTAL/.test(total.cells.getCell(iVal + 1).value.formula), 'sem a linha de total com soma');
    confere(aba.ws.views[0]?.state === 'frozen' && !!aba.ws.autoFilter, 'sem cabeçalho fixo/filtro');
  });

  await passo('Contas a pagar em PDF (Imprimir): A4 paisagem, várias páginas, empresa, resumo, linhas, rodapé "Página x de y" e "Usuário"', async () => {
    const r = await get(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${marca}&formato=pdf`);
    confere(r.status() === 200 && /application\/pdf/.test(r.headers()['content-type']) && /inline/.test(r.headers()['content-disposition']), `${r.status()} ${r.headers()['content-type']}`);
    const buf = await r.body();
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    confere(width > height, 'não está em paisagem');
    const { texto, paginas } = await textoDoPdf(buf);
    confere(paginas >= 3, `só ${paginas} página(s) para 70 linhas`);
    confere(/Contas a pagar/.test(texto) && /CONSTRUTORA PARCERIA/i.test(texto) && /04\.602\.232\/0001-70/.test(texto), 'sem título/empresa');
    confere(/Total do per[ií]odo/i.test(texto) && /emitido por /.test(texto) && new RegExp(`P[aá]gina 1 de ${paginas}`).test(texto) && new RegExp(`P[aá]gina ${paginas} de ${paginas}`).test(texto), 'sem resumo/rodapé/paginação');
    confere(/Fornecedor Exp\d+ 1\b/.test(texto) && /Fornecedor Exp\d+ 70\b/.test(texto), 'faltam linhas no PDF (primeira ou última)');
    confere(/Filtros aplicados/i.test(texto) && /Busca: /.test(texto), 'sem os filtros aplicados na última página');
    fs.writeFileSync(path.join(DIR, 'contas-a-pagar.pdf'), buf);
    return `${paginas} páginas`;
  });

  await passo('Contas a receber em Excel e PDF: título, resumo e rodapé; sem login pede entrada (401)', async () => {
    const x = await get('/recebimentos/exportar?periodo=todos');
    confere(x.status() === 200 && /spreadsheetml/.test(x.headers()['content-type']), `xlsx ${x.status()}`);
    const [aba] = await lerXlsx(await x.body());
    confere(aba.linhas[0].vals[0] === 'Contas a receber', `título: ${aba.linhas[0].vals[0]}`);
    dadosDaTabela(aba, 'Vencimento');
    const pf = await get('/recebimentos/exportar?periodo=todos&formato=pdf');
    confere(pf.status() === 200 && /application\/pdf/.test(pf.headers()['content-type']), `pdf ${pf.status()}`);
    const { texto } = await textoDoPdf(await pf.body());
    confere(/Contas a receber/.test(texto) && /Recebidos \(R\$\)/i.test(texto) && /P[aá]gina 1 de/.test(texto), 'PDF de receber incompleto');
    const anon = await (await b.newContext()).request.get(BASE + '/recebimentos/exportar', { maxRedirects: 0 });
    confere([401, 302, 307].includes(anon.status()), `sem login: ${anon.status()}`);
  });

  await passo('Relatórios em Excel (abas organizadas) e PDF (resumo e filtros)', async () => {
    const qs = `base=vencimento&de=2020-01-01&ate=${hoje}`;
    const x = await get(`/relatorios/exportar?${qs}`);
    confere(x.status() === 200 && /spreadsheetml/.test(x.headers()['content-type']), `xlsx ${x.status()}`);
    const abas = await lerXlsx(await x.body());
    const nomes = abas.map((a) => a.nome);
    for (const n of ['Extrato', 'Por centro de custo', 'Por categoria', 'Por fornecedor ou cliente', 'Por mês', 'Despesas (detalhe)']) confere(nomes.includes(n), `falta a aba ${n}: ${nomes}`);
    dadosDaTabela(abas[0], 'Data');
    const pf = await get(`/relatorios/exportar?${qs}&formato=pdf`);
    confere(pf.status() === 200 && /application\/pdf/.test(pf.headers()['content-type']), `pdf ${pf.status()}`);
    const { texto } = await textoDoPdf(await pf.body());
    confere(/Relat[oó]rio de extrato/.test(texto) && /Totais do per[ií]odo/i.test(texto) && /P[aá]gina 1 de/.test(texto), 'PDF do relatório incompleto');
  });

  await passo('regressão: texto com emoji/caracteres fora da fonte não derruba o PDF; "=" no início não vira fórmula no Excel', async () => {
    const nome = `=SOMA(1;1) 🏦 ${marca}`;
    await um(admin.from('pagamentos').insert({ obra_id: obra.id, favorecido: nome, descricao: 'teste ✓ ☺ — “aspas”', valor: 12.34, vencimento: hoje, forma_pagamento: 'pix', status: 'aguardando_pagamento', fluxo: obra.fluxo, created_by: fin }));
    const pdf = await get(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${marca}&formato=pdf`);
    confere(pdf.status() === 200, `pdf ${pdf.status()}`);
    const xl = await get(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${marca}`);
    const [aba] = await lerXlsx(await xl.body());
    const t = dadosDaTabela(aba, 'Vencimento');
    const iFav = t.cabecalho.indexOf('Favorecido');
    const linha = t.linhas.find((l) => /SOMA/.test(String(l[iFav])));
    confere(!!linha && !String(linha[iFav]).startsWith('='), `começa com "=" ou não achou: ${linha?.[iFav]}`);
  });

  // ───────────── Exportação = só o que está dentro do filtro (Contas a pagar, Contas a receber e Relatórios) ─────────────
  const finCli = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await finCli.auth.signInWithPassword({ email: 'financeiro@demo.local', password: 'Demo-1234' });
  const obras = await um(admin.from('obras').select('id, nome').order('nome').limit(2));
  const [obraA, obraB] = obras;
  const catRec = (await um(admin.from('categorias').insert({ nome: `Rec ${marca}`, tipo: 'receita' }).select('id').single())).id;
  const catDesp = (await um(admin.from('categorias').insert({ nome: `Desp ${marca}`, tipo: 'despesa' }).select('id').single())).id;
  const filt = `Filtro${marca}`;
  // despesas: 3 na obra A (1 com a categoria), 2 na obra B; receitas: 2 na obra A, 1 na obra B
  const dsp = (obra, i, extra = {}) => ({ obra_id: obra.id, favorecido: `Forn ${filt} ${i}`, descricao: `${filt} despesa ${i}`, valor: 50 + i, vencimento: hoje, forma_pagamento: i === 2 ? 'pix' : 'boleto', status: 'aguardando_pagamento', fluxo: 'C', created_by: fin, ...extra });
  await um(admin.from('pagamentos').insert([dsp(obraA, 1), dsp(obraA, 2, { categoria_id: catDesp }), dsp(obraA, 3), dsp(obraB, 4), dsp(obraB, 5)]));
  const vencAmanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const [o, d, v] of [[obraA, `${filt} receita A1`, 1000], [obraA, `${filt} receita A2`, 2000], [obraB, `${filt} receita B1`, 4000]]) {
    await um(finCli.rpc('criar_recebimento', { p_obra_id: o.id, p_categoria_id: catRec, p_cliente: `Cliente ${filt}`, p_descricao: d, p_valor: v, p_vencimento: vencAmanha }));
  }
  const xlsx = async (url) => dadosDaTabela((await lerXlsx(await (await get(url)).body()))[0], 'Vencimento');
  const textoPdf = async (url) => (await textoDoPdf(await (await get(url)).body())).texto;
  const conta = (texto, re) => (texto.match(re) ?? []).length;

  await passo('Contas a pagar: Excel e PDF trazem só o que está no filtro (busca + centro de custo, categoria, forma de pagamento e situação), igual à lista da tela', async () => {
    const casos = [
      [`busca=${filt}`, 5],
      [`busca=${filt}&obra=${obraA.id}`, 3],
      [`busca=${filt}&obra=${obraB.id}`, 2],
      [`busca=${filt}&obra=${obraA.id}&categoria=${catDesp}`, 1],
      [`busca=${filt}&forma=pix`, 1],
      [`busca=${filt}&cartao=pagos`, 0],
      [`busca=${filt}&cartao=hoje`, 5],
    ];
    for (const [qs, esperado] of casos) {
      const url = `/pagamentos/exportar?lista=contas&periodo=todos&${qs}`;
      const t = await xlsx(url);
      confere(t.linhas.length === esperado, `Excel (${qs}): ${t.linhas.length} linhas, esperado ${esperado}`);
      confere(t.linhas.every((l) => l.some((c) => String(c).includes(filt))), `Excel (${qs}): linha fora do filtro`);
      const pdf = await textoPdf(url + '&formato=pdf');
      confere(conta(pdf, new RegExp(`Forn ${filt} \\d`, 'g')) === esperado, `PDF (${qs}): ${conta(pdf, new RegExp(`Forn ${filt} \\d`, 'g'))} linhas, esperado ${esperado}`);
      // a lista da tela mostra a mesma quantidade
      await p.goto(`${BASE}/pagamentos?periodo=todos&${qs}`); await p.waitForLoadState('networkidle');
      const naTela = await p.locator('tr[data-linha]').count();
      confere(naTela === esperado, `tela (${qs}): ${naTela} linhas, esperado ${esperado}`);
    }
    // período: um mês sem lançamentos não leva nada
    const vazio = await xlsx(`/pagamentos/exportar?lista=contas&periodo=personalizado&de=2019-01-01&ate=2019-01-31&busca=${filt}`);
    confere(vazio.linhas.length === 0, `mês sem lançamento trouxe ${vazio.linhas.length} linhas`);
  });

  await passo('Contas a receber: Excel e PDF respeitam busca, centro de custo, situação e período', async () => {
    const casos = [
      [`busca=${filt}`, 3],
      [`busca=${filt}&obra=${obraA.id}`, 2],
      [`busca=${filt}&obra=${obraB.id}`, 1],
      [`busca=${filt}&cartao=recebidos`, 0],
      [`busca=${filt}&cartao=avencer`, 3],
    ];
    for (const [qs, esperado] of casos) {
      const url = `/recebimentos/exportar?periodo=todos&${qs}`;
      const t = await xlsx(url);
      confere(t.linhas.length === esperado, `Excel (${qs}): ${t.linhas.length} linhas, esperado ${esperado}`);
      const pdf = await textoPdf(url + '&formato=pdf');
      confere(conta(pdf, new RegExp(`${filt} receita`, 'g')) === esperado, `PDF (${qs}): ${conta(pdf, new RegExp(`${filt} receita`, 'g'))}, esperado ${esperado}`);
      await p.goto(`${BASE}/recebimentos?periodo=todos&${qs}`); await p.waitForLoadState('networkidle');
      const naTela = await p.locator('tr[data-linha]').count();
      confere(naTela === esperado, `tela (${qs}): ${naTela} linhas, esperado ${esperado}`);
    }
  });

  await passo('Relatórios (extrato): receitas e despesas juntas; Excel e PDF só com o filtro (centro de custo, categoria, tipo, busca, situação, período)', async () => {
    const base = `base=vencimento&de=${hoje}&ate=${vencAmanha}`;
    const extrato = async (qs) => {
      const [aba] = await lerXlsx(await (await get(`/relatorios/exportar?${base}&${qs}`)).body());
      const t = dadosDaTabela(aba, 'Data');
      return { t, aba, linhas: t.linhas.filter((l) => l.some((c) => String(c).includes(filt))) };
    };
    const casos = [
      [`busca=${filt}`, 8, 3, 5],
      [`busca=${filt}&obra=${obraA.id}`, 5, 2, 3],
      [`busca=${filt}&obra=${obraB.id}`, 3, 1, 2],
      [`busca=${filt}&tipo=receitas`, 3, 3, 0],
      [`busca=${filt}&tipo=despesas`, 5, 0, 5],
      [`busca=${filt}&categoria=${catRec}`, 3, 3, 0],
      [`busca=${filt}&categoria=${catDesp}`, 1, 0, 1],
      [`busca=${filt}&status=abertos`, 8, 3, 5],
      [`busca=${filt}&status=realizados`, 0, 0, 0],
    ];
    for (const [qs, total, rec, desp] of casos) {
      const x = await extrato(qs);
      const iTipo = x.t.cabecalho.indexOf('Tipo');
      confere(x.linhas.length === total, `Excel (${qs}): ${x.linhas.length} linhas, esperado ${total}`);
      confere(x.linhas.filter((l) => l[iTipo] === 'Receita').length === rec && x.linhas.filter((l) => l[iTipo] === 'Despesa').length === desp, `Excel (${qs}): receitas/despesas diferentes de ${rec}/${desp}`);
      // despesa com sinal negativo, receita positivo
      const iVal = x.t.cabecalho.indexOf('Valor (R$)');
      confere(x.linhas.every((l) => (l[iTipo] === 'Receita' ? l[iVal] > 0 : l[iVal] < 0)), `Excel (${qs}): sinal do valor errado`);
      const pdf = await textoPdf(`/relatorios/exportar?${base}&${qs}&formato=pdf`);
      confere(conta(pdf, new RegExp(`${filt} (despesa|receita)`, 'g')) === total, `PDF (${qs}): ${conta(pdf, new RegExp(`${filt} (despesa|receita)`, 'g'))} linhas, esperado ${total}`);
    }
    // resumo do PDF/Excel: receitas e despesas em aberto, realizadas e totais
    const pdf = await textoPdf(`/relatorios/exportar?${base}&busca=${filt}&formato=pdf`);
    confere(/Receitas em aberto/i.test(pdf) && /Despesas em aberto/i.test(pdf) && /Totais do per[ií]odo/i.test(pdf), 'resumo do extrato incompleto no PDF');
    // período fora dos lançamentos: nada
    const [fora] = await lerXlsx(await (await get(`/relatorios/exportar?base=vencimento&de=2019-01-01&ate=2019-01-31&busca=${filt}`)).body());
    confere(dadosDaTabela(fora, 'Data').linhas.length === 0, 'período sem lançamentos trouxe linhas');
  });

  await passo('Relatórios (tela): tem busca e filtros (tipo, centro de custo, categoria, situação, período); o extrato mostra receitas e despesas e respeita a busca', async () => {
    await p.goto(`${BASE}/relatorios?de=${hoje}&ate=${vencAmanha}&busca=${filt}`); await p.waitForLoadState('networkidle');
    confere(await p.locator('[data-busca-relatorio] input[name=busca]').count() === 1, 'sem a caixa de busca');
    confere(await p.locator('[data-extrato-linha="receita"]').count() === 3 && await p.locator('[data-extrato-linha="despesa"]').count() === 5, 'o extrato não mostra 3 receitas e 5 despesas');
    await p.locator('details summary').first().click();
    for (const nome of ['tipo', 'obra', 'categoria', 'status', 'busca', 'base', 'de', 'ate']) confere(await p.locator(`form select[name=${nome}], form input[name=${nome}]`).count() >= 1, `sem o filtro ${nome}`);
    await p.goto(`${BASE}/relatorios?de=${hoje}&ate=${vencAmanha}&busca=${filt}&tipo=receitas&obra=${obraB.id}`); await p.waitForLoadState('networkidle');
    confere(await p.locator('[data-extrato-linha]').count() === 1, 'filtro combinado (receitas da obra B) deveria dar 1 linha');
    // a exportação aberta a partir dessa tela leva o mesmo filtro
    const href = await p.locator('a[href*="/relatorios/exportar"]:not([href*="formato=pdf"])').first().getAttribute('href');
    confere(/tipo=receitas/.test(href) && /busca=Filtro/.test(href) && href.includes(obraB.id), `link de exportar sem os filtros: ${href}`);
  });

  console.log(`\nExportações: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
