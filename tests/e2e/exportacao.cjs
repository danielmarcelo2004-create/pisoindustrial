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
    confere(!!primeira.cells.getCell(iSit + 1).fill?.fgColor?.argb, 'situação sem cor');
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
    confere(/Total do per[ií]odo/.test(texto) && /Usu[aá]rio: /.test(texto) && new RegExp(`P[aá]gina 1 de ${paginas}`).test(texto) && new RegExp(`P[aá]gina ${paginas} de ${paginas}`).test(texto), 'sem resumo/rodapé/paginação');
    confere(/Fornecedor Exp\d+ 1\b/.test(texto) && /Fornecedor Exp\d+ 70\b/.test(texto), 'faltam linhas no PDF (primeira ou última)');
    confere(/Filtros aplicados/.test(texto) && /Busca: /.test(texto), 'sem os filtros aplicados na última página');
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
    confere(/Contas a receber/.test(texto) && /Recebidos \(R\$\)/.test(texto) && /P[aá]gina 1 de/.test(texto), 'PDF de receber incompleto');
    const anon = await (await b.newContext()).request.get(BASE + '/recebimentos/exportar', { maxRedirects: 0 });
    confere([401, 302, 307].includes(anon.status()), `sem login: ${anon.status()}`);
  });

  await passo('Relatórios em Excel (abas organizadas) e PDF (resumo e filtros)', async () => {
    const qs = `base=vencimento&de=2020-01-01&ate=${hoje}`;
    const x = await get(`/relatorios/exportar?${qs}`);
    confere(x.status() === 200 && /spreadsheetml/.test(x.headers()['content-type']), `xlsx ${x.status()}`);
    const abas = await lerXlsx(await x.body());
    const nomes = abas.map((a) => a.nome);
    for (const n of ['Pagamentos', 'Por centro de custo', 'Por categoria', 'Por fornecedor', 'Por mês', 'Por situação']) confere(nomes.includes(n), `falta a aba ${n}: ${nomes}`);
    dadosDaTabela(abas[0], 'Nº');
    const pf = await get(`/relatorios/exportar?${qs}&formato=pdf`);
    confere(pf.status() === 200 && /application\/pdf/.test(pf.headers()['content-type']), `pdf ${pf.status()}`);
    const { texto } = await textoDoPdf(await pf.body());
    confere(/Relat[oó]rio de pagamentos/.test(texto) && /Total do per[ií]odo/.test(texto) && /P[aá]gina 1 de/.test(texto), 'PDF do relatório incompleto');
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

  console.log(`\nExportações: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
