// Persona "Beto, usuário curioso/mal-intencionado" — parte 2: pelo endereço do navegador e pelas rotas HTTP.
// Cabeçalhos de segurança, /api/cron sem segredo, redirecionamento aberto, URLs de obra alheia, IDs inexistentes (404 e não 500),
// injeção nos campos de busca, texto malicioso nas telas (XSS), segredos no código que vai ao navegador.
// Parte 1 (API REST/RPC/Storage do Supabase): seguranca-invasor.cjs.
const fs = require('fs');
const path = require('path');
const { BASE, admin, um, marca, confere, cliente, rodar } = require('./_util.cjs');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const FALSO = '00000000-0000-4000-8000-00000000dead';
const sem5xx = (s, onde) => confere(s < 500, `${onde} deu erro ${s}`);
const textoDe = (p) => p.innerText('body');
const get = (url, opts = {}) => fetch(BASE + url, { redirect: 'manual', ...opts });
const vaiParaLogin = (r) => (r.status >= 300 && r.status < 400 && /\/login/.test(r.headers.get('location') ?? ''));

rodar('Segurança — invasor (web)', async ({ b, passo, entrar }) => {
  // ---------- preparação ----------
  const fin = await cliente('financeiro');
  const eng = await cliente('engenheiro');
  const M = marca('web');
  const perfis = await um(admin.from('profiles').select('id, email'));
  const obras = await um(admin.from('obras').select('id, nome, fluxo, engenheiro_id, administrador_id'));
  const visiveisEng = (await um(eng.from('obras').select('id'))).map((o) => o.id);
  const obraAlheia = obras.find((o) => !visiveisEng.includes(o.id));
  const obraEng = obras.find((o) => visiveisEng.includes(o.id) && o.administrador_id);
  confere(obraAlheia && obraEng, 'base de teste sem obras alheia/própria');
  const novo = (obra, favorecido, descricao) => um(fin.rpc('criar_pagamento', { p_obra_id: obra, p_fornecedor_id: null, p_favorecido: favorecido, p_descricao: descricao, p_valor: 777.77, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null }));
  const canarioAlheio = `CanarioAlheio${M.replace(/\W/g, '')}`;
  const idAlheio = await novo(obraAlheia.id, canarioAlheio, 'pagamento de outra obra');
  const xss = `<img src=x onerror="window.__xss=1"> ${M}`;
  const idXss = await novo(obraEng.id, xss, `"><script>window.__xss=2</script> ${M}`);
  const docAlheio = (await um(admin.from('documentos').select('id').eq('obra_id', obraAlheia.id).limit(1)))[0];
  const docReal = (await um(admin.from('documentos').select('id').limit(1)))[0];
  const opAlheia = (await um(admin.from('ordens_pagamento').select('id').limit(1)))[0];
  confere(docAlheio && docReal, 'sem documentos na base');
  const notificacao = (await um(admin.from('notificacoes').select('id').limit(1)))[0];

  // =================== CABEÇALHOS ===================
  await passo('cabeçalhos: X-Frame-Options DENY, HSTS ≥ 1 ano, nosniff, Referrer-Policy e CSP só em modo relatório (Report-Only) com frame-ancestors none — em página, rota de API e erro 404', async () => {
    for (const url of ['/login', '/api/cron/email', '/documentos/abc', '/rota-que-nao-existe']) {
      const r = await get(url);
      const h = (n) => r.headers.get(n) ?? '';
      confere(h('x-frame-options').toUpperCase() === 'DENY', `${url}: X-Frame-Options = "${h('x-frame-options')}"`);
      const hsts = /max-age=(\d+)/.exec(h('strict-transport-security'));
      confere(hsts && Number(hsts[1]) >= 31536000, `${url}: HSTS = "${h('strict-transport-security')}"`);
      confere(h('x-content-type-options') === 'nosniff', `${url}: nosniff ausente`);
      confere(h('referrer-policy') !== '', `${url}: Referrer-Policy ausente`);
      confere(h('permissions-policy').includes('camera=()'), `${url}: Permissions-Policy ausente`);
      const csp = h('content-security-policy-report-only');
      confere(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), `${url}: CSP em relatório incompleta: ${csp.slice(0, 120)}`);
      confere(h('content-security-policy') === '', `${url}: CSP já está em modo bloqueio (combinado: só relatório por ora)`);
    }
  });

  await passo('cabeçalhos: nenhuma resposta de erro ou redirecionamento expõe versão do servidor, rastreio de pilha ou caminho de arquivo', async () => {
    for (const url of ['/rota-que-nao-existe', '/documentos/abc', `/pagamentos/${FALSO}`, '/api/cron/whatsapp', '/_next/data/x.json']) {
      const r = await get(url);
      const t = await r.text();
      confere(!/at .*\.(ts|js):\d+|node_modules|\/home\/|stack|ECONNREFUSED|supabase_|postgres/i.test(t), `${url}: corpo traz detalhe interno: ${t.slice(0, 160)}`);
      confere(!/Server|nginx|apache/i.test(r.headers.get('server') ?? ''), `${url}: cabeçalho Server revela software: ${r.headers.get('server')}`);
    }
  });

  // =================== CRON ===================
  await passo('/api/cron/email e /whatsapp: sem segredo, com segredo errado (mesmo tamanho, maior, menor, vazio, "Bearer undefined"/"null"), no corpo, na URL, em cookie ou por POST → sempre recusado, sem dados', async () => {
    for (const rota of ['/api/cron/email', '/api/cron/whatsapp']) {
      const tentativas = [
        {},
        { headers: { authorization: '' } },
        { headers: { authorization: 'Bearer' } },
        { headers: { authorization: 'Bearer ' } },
        { headers: { authorization: 'Bearer undefined' } },
        { headers: { authorization: 'Bearer null' } },
        { headers: { authorization: 'Bearer segredo-errado' } },
        { headers: { authorization: 'Bearer ' + 'a'.repeat(14) } },
        { headers: { authorization: 'Bearer ' + 'a'.repeat(500) } },
        { headers: { authorization: 'bearer segredo-teste' } },
        { headers: { authorization: 'Basic c2VncmVkby10ZXN0ZQ==' } },
        { headers: { 'x-vercel-cron': '1' } },
        { headers: { cookie: 'CRON_SECRET=segredo-teste' } },
        { headers: { authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` } },
        { headers: { authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}` } },
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"x"}' },
        { method: 'PUT' },
        { method: 'DELETE' },
      ];
      for (const t of tentativas) {
        const r = await get(rota, t);
        const corpo = await r.text();
        confere([401, 403, 404, 405].includes(r.status), `${rota} ${t.method ?? 'GET'} ${J(t.headers ?? {})}: respondeu ${r.status} ${corpo.slice(0, 80)}`);
        confere(!/enviados|reservados|telefone|email"\s*:|usuario/i.test(corpo), `${rota}: corpo traz dados: ${corpo.slice(0, 100)}`);
      }
      for (const q of ['?secret=segredo-teste', '?CRON_SECRET=segredo-teste', '?authorization=Bearer%20segredo-teste', '?token=x']) {
        const r = await get(rota + q);
        confere(r.status === 401, `${rota}${q}: segredo na URL funcionou (${r.status})`);
      }
    }
  });

  // =================== SEM LOGIN ===================
  await passo('sem login: páginas, documentos, PDF de OP, notificações e exportações mandam para /login e não entregam conteúdo; ação de servidor inventada não gera erro 500', async () => {
    const urls = ['/', '/pagamentos', `/pagamentos/${idAlheio}`, `/pagamentos/${idAlheio}/editar`, '/obras', '/fornecedores', '/usuarios', '/auditoria', '/contas-bancarias', '/compras', '/agenda', '/pagamentos/exportar', '/relatorios/exportar', '/aprovacoes', `/documentos/${docReal.id}`, `/documentos/${docReal.id}?baixar`, '/notificacoes', `/notificacoes/${notificacao?.id ?? FALSO}`, `/ops/${opAlheia?.id ?? FALSO}/pdf`, '/perfil', '/trocar-senha'];
    for (const u of urls) {
      const r = await get(u);
      confere(vaiParaLogin(r), `${u}: sem login respondeu ${r.status} ${r.headers.get('location') ?? ''}`);
      const t = await r.text();
      confere(!t.includes(canarioAlheio) && !t.includes('@demo.local'), `${u}: corpo vazou dado sem login`);
    }
    const r = await get('/pagamentos', { method: 'POST', headers: { 'next-action': 'abcdef0123456789abcdef0123456789abcdef01', 'content-type': 'text/plain;charset=UTF-8' }, body: '[]' });
    sem5xx(r.status, 'ação de servidor inventada sem login');
    confere(vaiParaLogin(r) || r.status === 404 || r.status === 400, `ação inventada respondeu ${r.status}`);
    return `${urls.length} URLs`;
  });

  await passo('sair: depois de /sair a sessão não vale mais — voltar ao sistema exige novo login', async () => {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'engenheiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);
    await p.goto(BASE + '/sair'); await p.waitForLoadState('networkidle');
    confere(new URL(p.url()).pathname === '/login', `/sair levou a ${p.url()}`);
    await p.goto(BASE + '/pagamentos'); await p.waitForLoadState('networkidle');
    confere(new URL(p.url()).pathname === '/login', 'depois de sair, /pagamentos abriu sem login');
    const r = await p.request.get(BASE + `/documentos/${docReal.id}`, { maxRedirects: 0 });
    confere(vaiParaLogin({ status: r.status(), headers: { get: (n) => r.headers()[n] } }), 'depois de sair, documento abriu');
    await ctx.close();
  });

  // =================== REDIRECIONAMENTO ABERTO ===================
  await passo('redirecionamento aberto: o parâmetro "voltar" do login nunca leva para outro site (//host, https://host, /\\host, /%09/host, javascript:, \\\\host)', async () => {
    const maus = ['//evil.example/x', 'https://evil.example/x', '/\\evil.example/x', '/%5Cevil.example/x', '/\t/evil.example/x', '/%09/evil.example', '/%0d%0a//evil.example', 'javascript:alert(1)', '\\\\evil.example', 'evil.example', '///evil.example', 'http:evil.example', '/@evil.example', '//evil.example\\@127.0.0.1'];
    const falhas = [];
    for (const mau of maus) {
      const ctx = await b.newContext(); const p = await ctx.newPage();
      const visitou = [];
      await ctx.route((u) => u.hostname === 'evil.example', (rt) => { visitou.push(rt.request().url()); rt.fulfill({ status: 200, contentType: 'text/html', body: 'evil' }); });
      await p.goto(BASE + '/login?voltar=' + encodeURIComponent(mau));
      await p.fill('input[name=email]', 'engenheiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
      await p.click('button:has-text("Entrar")');
      await p.waitForTimeout(2500); await p.waitForLoadState('networkidle').catch(() => {});
      const host = new URL(p.url()).host;
      if (!(visitou.length === 0 && host === new URL(BASE).host)) falhas.push(`voltar=${JSON.stringify(mau)} levou a ${p.url()}`);
      await ctx.close();
    }
    confere(falhas.length === 0, `${falhas.length} variação(ões) escaparam: ${falhas.join(' | ')}`);
    return `${maus.length} variações`;
  });

  await passo('redirecionamento aberto: Host/X-Forwarded-Host forjados em /sair e em rota de documentos não mandam o navegador para outro domínio', async () => {
    for (const [url, cab] of [['/sair', { 'x-forwarded-host': 'evil.example' }], ['/sair?motivo=inativo', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }], [`/documentos/${docReal.id}`, { 'x-forwarded-host': 'evil.example' }], [`/notificacoes/${notificacao?.id ?? FALSO}`, { 'x-forwarded-host': 'evil.example' }], ['/', { 'x-forwarded-host': 'evil.example' }]]) {
      const r = await get(url, { headers: cab });
      const loc = r.headers.get('location') ?? '';
      confere(!/evil\.example/.test(loc), `${url} com ${J(cab)} redirecionou para ${loc}`);
    }
  });

  // =================== OBRA ALHEIA / IDS ===================
  await passo('URL direta de obra alheia (engenheiro): pagamento, edição, obra, documento e PDF de OP dão 404 e não mostram nada do pagamento alheio', async () => {
    const p = await entrar('engenheiro');
    const urls = [`/pagamentos/${idAlheio}`, `/pagamentos/${idAlheio}/editar`, `/pagamentos/${idAlheio}/parcelas`, `/obras/${obraAlheia.id}`, `/documentos/${docAlheio.id}`, `/documentos/${docAlheio.id}?baixar`];
    for (const u of urls) {
      const r = await p.request.get(BASE + u, { maxRedirects: 0 });
      const t = await r.text();
      confere([404, 307, 403].includes(r.status()), `${u}: respondeu ${r.status()}`);
      confere(!t.includes(canarioAlheio) && !t.includes('777,77'), `${u}: mostrou dados do pagamento alheio`);
    }
    for (const u of [`/pagamentos/${idAlheio}`, `/obras/${obraAlheia.id}`]) {
      const r = await p.goto(BASE + u);
      confere(r.status() === 404, `${u}: navegador recebeu ${r.status()}`);
      confere(!(await textoDe(p)).includes(canarioAlheio), `${u}: tela mostrou o canário`);
    }
    if (opAlheia) { const r = await p.request.get(BASE + `/ops/${opAlheia.id}/pdf`, { maxRedirects: 0 }); const ok = (await admin.from('ordens_pagamento').select('id').eq('id', opAlheia.id)).data?.length; void ok; confere(r.status() !== 500, 'PDF de OP deu 500'); }
    return `${urls.length} URLs`;
  });

  await passo('lista, busca e exportação (engenheiro): o pagamento da obra alheia não aparece na lista, na busca por nome, na busca por número nem no CSV', async () => {
    const p = await entrar('engenheiro');
    const alvo = canarioAlheio;
    await p.goto(BASE + '/pagamentos?periodo=todos&cancelados=1'); await p.waitForLoadState('networkidle');
    confere(!(await textoDe(p)).includes(alvo), 'lista mostrou o pagamento alheio');
    await p.goto(BASE + `/pagamentos?periodo=todos&cancelados=1&busca=${encodeURIComponent(alvo)}`); await p.waitForLoadState('networkidle');
    confere(!(await textoDe(p)).includes(alvo + ' '), 'busca por nome achou o pagamento alheio'); // o eco do termo na caixa de busca não conta como resultado
    const numero = (await um(admin.from('pagamentos').select('numero').eq('id', idAlheio).single())).numero;
    await p.goto(BASE + `/pagamentos?periodo=todos&cancelados=1&busca=${numero}`); await p.waitForLoadState('networkidle');
    confere(!(await textoDe(p)).includes(alvo), 'busca por número achou o pagamento alheio');
    for (const q of ['', '?periodo=todos', `?periodo=todos&busca=${alvo}`, `?obra=${obraAlheia.id}&periodo=todos`]) {
      const r = await p.request.get(BASE + '/pagamentos/exportar' + q, { maxRedirects: 0 });
      sem5xx(r.status(), 'exportação');
      confere(!(await r.text()).includes(alvo), `CSV${q} trouxe o pagamento alheio`);
    }
    await p.goto(BASE + `/pagamentos?obra=${obraAlheia.id}&periodo=todos`); await p.waitForLoadState('networkidle');
    confere(!(await textoDe(p)).includes(alvo), 'filtro por obra alheia mostrou o pagamento');
  });

  await passo('telas só do Financeiro/master por URL direta (engenheiro, administrador, suprimentos): usuários, nova obra, auditoria, contas bancárias, conciliação — redirecionam, sem mostrar dados nem erro', async () => {
    const proibidas = { engenheiro: ['/usuarios', '/usuarios/novo', `/usuarios/${perfis[0].id}`, '/obras/nova', '/auditoria', '/contas-bancarias', '/conciliacao', '/notas-medicao'], administrador: ['/usuarios', '/usuarios/novo', '/obras/nova', '/auditoria', '/contas-bancarias', '/conciliacao'], suprimentos: ['/usuarios', `/usuarios/${perfis[0].id}`, '/obras/nova', '/auditoria', '/contas-bancarias', '/conciliacao'] };
    let n = 0;
    for (const [perfil, urls] of Object.entries(proibidas)) {
      const p = await entrar(perfil);
      for (const u of urls) {
        const r = await p.request.get(BASE + u, { maxRedirects: 0 });
        n++;
        confere(r.status() >= 300 && r.status() < 400 || r.status() === 403 || r.status() === 404, `${perfil} abriu ${u} (${r.status()})`);
        const t = await r.text();
        confere(!/@demo\.local/.test(t), `${perfil}: ${u} mostrou e-mails de colegas`);
      }
    }
    return `${n} acessos`;
  });

  await passo('IDs inexistentes ou malformados (engenheiro e Financeiro): a página responde 404 (ou redireciona), nunca 500, sem erro de JavaScript', async () => {
    const urls = [`/pagamentos/${FALSO}`, '/pagamentos/abc', '/pagamentos/%00', `/pagamentos/${FALSO}/editar`, `/pagamentos/${FALSO}/parcelas`, `/obras/${FALSO}`, '/obras/abc', `/fornecedores/${FALSO}`, `/usuarios/${FALSO}`, `/ops/${FALSO}/pdf`, '/ops/abc/pdf', `/documentos/${FALSO}`, '/documentos/abc', '/documentos/..%2f..%2fetc%2fpasswd', `/notificacoes/${FALSO}`, '/notificacoes/abc', `/fundos-fixos/${FALSO}`, `/recebimentos/${FALSO}`, `/pagamentos/${'9'.repeat(5000)}`, `/pagamentos/'%20or%201=1--`];
    for (const perfil of ['engenheiro', 'financeiro']) {
      const p = await entrar(perfil);
      for (const u of urls) {
        const r = await p.request.get(BASE + u, { maxRedirects: 0 });
        confere(r.status() < 500, `${perfil} ${u.slice(0, 60)}: erro ${r.status()}`);
        confere([404, 303, 307, 308, 400, 414, 431].includes(r.status()), `${perfil} ${u.slice(0, 60)}: respondeu ${r.status()} (esperado 404 ou redirecionamento)`);
        confere(!/Internal Server Error|Application error|Unhandled Runtime Error/i.test(await r.text()), `${perfil} ${u.slice(0, 60)}: tela de erro interno`);
      }
    }
    return `${urls.length * 2} acessos`;
  });

  await passo('404 amigável: página inexistente mostra mensagem em português ("não encontrada") com caminho de volta ao sistema, e não o texto padrão em inglês do Next', async () => {
    const p = await entrar('engenheiro');
    for (const u of [`/pagamentos/${FALSO}`, '/pagamentos/abc', `/obras/${FALSO}`, '/rota-que-nao-existe']) {
      const r = await p.goto(BASE + u);
      confere(r.status() === 404, `${u}: ${r.status()}`);
      const t = await textoDe(p);
      confere(/não (foi )?encontrad|não existe|inexistente/i.test(t) && !/This page could not be found/i.test(t), `${u}: a tela de 404 está em inglês/sem aviso amigável (texto: "${t.replace(/\s+/g, ' ').slice(-90)}")`);
    }
  });

  // =================== BUSCA / INJEÇÃO / XSS ===================
  await passo('injeção nos campos de busca e filtros (aspas, %, vírgula, ponto e vírgula, parênteses, filtro forjado, SQL, 5 mil caracteres, nulo): sem erro 500 e o engenheiro não ganha acesso à obra alheia', async () => {
    const cargas = [`'`, `"`, `%`, `_`, `\\`, `,`, `;`, `)(`, `a,b.c`, `x%,id.not.is.null`, `x),obra_id.eq.${obraAlheia.id},(favorecido.ilike.%`, `'; drop table public.pagamentos; --`, `' or '1'='1`, `%27%20or%201=1`, `<script>window.__xss=3</script>`, '\u0000x', `${'a'.repeat(5000)}`, `ç~^´\`áéí`, '${7*7}', '{{7*7}}'];
    const rotas = (v) => [`/pagamentos?periodo=todos&busca=${v}`, `/pagamentos?periodo=todos&fornecedor=${v}&obra=${v}&conta=${v}&categoria=${v}`, `/fornecedores?busca=${v}`, `/compras?material=${v}&fornecedor=${v}&cidade=${v}`, `/agenda?busca=${v}`, `/aprovacoes?busca=${v}`, `/relatorios?busca=${v}`, `/obras?busca=${v}`, `/pagamentos?periodo=${v}&mes=${v}&de=${v}&ate=${v}&pagina=${v}`];
    const antes = (await admin.from('pagamentos').select('*', { count: 'exact', head: true })).count;
    let n = 0; const erros = [];
    for (const perfil of ['engenheiro', 'financeiro']) {
      const p = await entrar(perfil);
      let dialogo = false; p.on('dialog', (d) => { dialogo = true; d.dismiss(); });
      for (const c of cargas) {
        for (const u of rotas(encodeURIComponent(c))) {
          const r = await p.request.get(BASE + u.slice(0, 7000), { maxRedirects: 0 });
          n++;
          if (r.status() >= 500) erros.push(`${perfil} ${u.slice(0, 40)}…(${u.length} car.) → ${r.status()}`);
          if (perfil === 'engenheiro') confere(!(await r.text()).includes(canarioAlheio), `${perfil} ${u.slice(0, 90)} trouxe o pagamento alheio`);
        }
      }
      await p.goto(BASE + `/pagamentos?busca=${encodeURIComponent('<script>window.__xss=3</script>')}`); await p.waitForLoadState('networkidle');
      confere(!dialogo && (await p.evaluate(() => window.__xss)) === undefined, `${perfil}: o termo de busca executou script na tela`);
    }
    confere((await admin.from('pagamentos').select('*', { count: 'exact', head: true })).count >= antes, 'a tabela de pagamentos perdeu linhas (injeção SQL?)');
    confere(erros.length === 0, `${erros.length} resposta(s) 500: ${[...new Set(erros)].slice(0, 6).join(' | ')}`);
    return `${n} requisições`;
  });

  await passo('XSS armazenado: favorecido com <img onerror> e descrição com <script> aparecem como TEXTO nas telas do administrador — nada executa', async () => {
    const adminP = await entrar('administrador');
    let dialogo = null; adminP.on('dialog', (d) => { dialogo = d.message(); d.dismiss(); });
    const urls = [`/pagamentos/${idXss}`, '/pagamentos?periodo=todos', `/pagamentos?periodo=todos&busca=${encodeURIComponent(M)}`, '/aprovacoes', '/agenda', '/', '/notificacoes', '/fornecedores'];
    for (const u of urls) {
      await adminP.goto(BASE + u); await adminP.waitForLoadState('networkidle'); await adminP.waitForTimeout(300);
      confere(dialogo === null, `${u}: abriu diálogo (script rodou): ${dialogo}`);
      confere((await adminP.evaluate(() => window.__xss)) === undefined, `${u}: window.__xss definido (script rodou)`);
      confere((await adminP.locator('img[src="x"]').count()) === 0, `${u}: a tag <img> do favorecido virou elemento`);
    }
    await adminP.goto(BASE + `/pagamentos/${idXss}`); await adminP.waitForLoadState('networkidle');
    confere((await textoDe(adminP)).includes('<img src=x'), 'o texto do favorecido não apareceu escapado (devia aparecer como texto)');
  });

  await passo('injeção de fórmula na planilha: favorecido começando com = + - @ não pode virar fórmula ao abrir o CSV no Excel', async () => {
    const f = `=HYPERLINK("http://evil.example","clique")${M.replace(/\W/g, '')}`;
    const id = await novo(obraEng.id, f, 'teste de fórmula');
    const finP = await entrar('financeiro');
    const r = await finP.request.get(BASE + `/pagamentos/exportar?periodo=todos&busca=${encodeURIComponent(M.replace(/\W/g, ''))}&cancelados=1`);
    const csv = await r.text();
    const linha = csv.split('\n').find((l) => l.includes('HYPERLINK'));
    confere(linha, 'o pagamento de teste não apareceu no CSV');
    confere(!/(^|;)"?=HYPERLINK/.test(linha), `o CSV traz célula começando com "=" (fórmula executável no Excel): ${linha.slice(0, 120)}`);
    void id;
  });

  // =================== SEGREDOS NO NAVEGADOR ===================
  await passo('segredos: a chave de serviço (SUPABASE_SECRET_KEY) e o CRON_SECRET não aparecem no HTML nem nos scripts enviados ao navegador; arquivos de configuração não são servidos', async () => {
    const segredos = [env.SUPABASE_SECRET_KEY, env.CRON_SECRET, 'segredo-teste'].filter((x) => x && x.length > 8);
    confere(env.SUPABASE_SECRET_KEY, 'sem SUPABASE_SECRET_KEY no .env.local para comparar');
    const html = await (await get('/login')).text();
    const scripts = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]))];
    confere(scripts.length > 0, 'não achei scripts na página de login');
    let bytes = html.length;
    for (const s of segredos) confere(!html.includes(s), 'segredo no HTML do login');
    for (const s of scripts) { const t = await (await get(s)).text(); bytes += t.length; for (const seg of segredos) confere(!t.includes(seg), `segredo encontrado em ${s}`); confere(!/service_role/.test(t) || !/eyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{20,}/.test(t.replace(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, '')), `JWT de serviço em ${s}`); }
    for (const u of ['/.env', '/.env.local', '/.git/config', '/.git/HEAD', '/supabase/config.toml', '/package.json', '/next.config.ts', '/src/proxy.ts', '/tests/e2e/personas/_util.cjs', '/_next/../.env.local', '/%2e%2e/.env.local', '/api/../.env.local']) {
      const r = await get(u); const t = await r.text();
      confere(!/SUPABASE_SECRET_KEY|service_role|\[auth\]|\[core\]|"scripts"/.test(t), `${u} serviu arquivo sensível (${r.status})`);
    }
    return `${scripts.length} scripts, ${(bytes / 1024) | 0} KB examinados`;
  });

  await passo('limpeza: o Financeiro cancela os pagamentos de teste (controle positivo)', async () => {
    const ids = (await um(admin.from('pagamentos').select('id').like('favorecido', `%${M.replace(/\W/g, '')}%`).neq('status', 'cancelado'))).map((p) => p.id);
    for (const id of [idAlheio, idXss, ...ids]) await fin.rpc('cancelar_pagamento', { p_id: id, p_motivo: 'limpeza do teste de segurança' });
    confere((await um(admin.from('pagamentos').select('status').eq('id', idAlheio).single())).status === 'cancelado', 'não cancelou');
  });
});

function J(x) { return JSON.stringify(x); }
