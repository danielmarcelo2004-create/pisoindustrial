// "Teste do macaco" (gremlins.js): em cada tela, com cada perfil, gremlins clicam, digitam, preenchem formulários
// e rolam a página ao acaso. Falha se aparecer erro de JavaScript, resposta 500 do servidor ou tela em branco.
// Roda contra o banco de demonstração (dados fictícios); ações sem volta (sair, excluir) ficam de fora.
// Uso: node tests/e2e/gremlins.cjs [perfil] [quantidade de ações por tela, padrão 300]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const ACOES = Number(process.argv[3] || 300);
const GREMLINS = fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'gremlins.js', 'dist', 'gremlins.min.js'), 'utf8');

const PERFIS = {
  financeiro: ['/', '/agenda', '/pagamentos', '/pagamentos/novo', '/recebimentos', '/contas-bancarias', '/obras', '/provisoes', '/fundos-fixos', '/notas-contabeis', '/notas-medicao', '/fornecedores', '/categorias', '/relatorios', '/compras', '/usuarios', '/auditoria'],
  suprimentos: ['/', '/agenda', '/pagamentos', '/pagamentos/novo', '/recebimentos', '/obras', '/provisoes', '/fundos-fixos', '/notas-contabeis', '/fornecedores', '/relatorios', '/compras'],
  engenheiro: ['/', '/agenda', '/pagamentos', '/pagamentos/novo', '/recebimentos', '/aprovacoes', '/perfil', '/obras', '/provisoes', '/fundos-fixos', '/relatorios'],
  administrador: ['/', '/agenda', '/pagamentos', '/recebimentos', '/aprovacoes', '/perfil', '/obras', '/provisoes', '/relatorios', '/compras'],
  administrador_master: ['/', '/agenda', '/pagamentos', '/recebimentos', '/aprovacoes', '/contas-bancarias', '/obras', '/provisoes', '/categorias', '/relatorios', '/compras'],
};
const EMAIL = { administrador_master: 'master@demo.local' };

// Não clicar no que tira da sessão ou apaga coisas (o resto vale: abrir menus, janelas, filtros, formulários)
const PROIBIDO = `a[href^="/sair"], form[action="/sair"] *, [data-gremlins-nao], a[download], a[href*="exportar"], a[target="_blank"]`;
const PALAVRAS_PROIBIDAS = /^(sair|excluir|cancelar|desfazer|arquivar|rejeitar|remover|apagar|restaurar)/i;

(async () => {
  const so = process.argv[2];
  const b = await chromium.launch();
  const problemas = [];
  let telas = 0;
  for (const [perfil, rotas] of Object.entries(PERFIS)) {
    if (so && so !== perfil) continue;
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    let atual = '';
    p.on('pageerror', (e) => problemas.push(`[${perfil}] ${atual}: erro de JavaScript — ${e.message.slice(0, 160)}`));
    p.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(BASE)) problemas.push(`[${perfil}] ${atual}: HTTP ${r.status()} em ${r.url().replace(BASE, '')}`); });
    p.on('dialog', (d) => d.dismiss()); // confirmações ("Cancelar esta provisão?") respondem "não"
    try {
      await p.goto(BASE + '/login');
      await p.fill('input[name=email]', EMAIL[perfil] ?? `${perfil}@demo.local`);
      await p.fill('input[name=senha]', SENHA);
      await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
    } catch {
      console.log(`– ${perfil}: usuário de demonstração não existe, pulando`);
      await ctx.close();
      continue;
    }
    for (const rota of rotas) {
      atual = rota;
      telas++;
      await p.goto(BASE + rota);
      await p.waitForLoadState('networkidle').catch(() => {});
      if (new URL(p.url()).pathname.startsWith('/login')) { problemas.push(`[${perfil}] ${rota}: caiu para o login`); break; }
      const vazia = (await p.locator('main').innerText().catch(() => '')).trim().length < 20;
      if (vazia) problemas.push(`[${perfil}] ${rota}: tela em branco`);
      await p.addScriptTag({ content: GREMLINS });
      await p.evaluate(
        async ({ acoes, proibido, palavras }) => {
          const g = window.gremlins;
          const pode = (el) => {
            if (!el || !(el instanceof Element)) return false;
            if (el.closest(proibido) || el.closest('nav') || el.closest('aside')) return false;
            const alvo = el.closest('a,button,[role=menuitem],[role=button]');
            if (alvo && new RegExp(palavras, 'i').test((alvo.textContent || '').trim())) return false;
            // links que saem para outra tela: deixam o gremlin onde está
            if (el.closest('a[href]') && !el.closest('a[href^="#"]')) return false;
            return true;
          };
          const horda = g.createHorde({
            species: [
              g.species.clicker({ canClick: pode }),
              g.species.toucher({ canTouch: pode }),
              g.species.formFiller({ canFillElement: pode }),
              g.species.scroller(),
              g.species.typer(),
            ],
            mogwais: [g.mogwais.alert(), g.mogwais.gizmo({ maxErrors: 1000 })],
            strategies: [g.strategies.distribution({ nb: acoes, delay: 5 })],
            randomizer: new g.Chance(1234),
          });
          await horda.unleash().catch(() => {});
        },
        { acoes: ACOES, proibido: PROIBIDO, palavras: PALAVRAS_PROIBIDAS.source },
      ).catch((e) => {
        // navegação causada por um gremlin (ex.: envio de formulário) encerra a rodada desta tela
        if (!/Execution context was destroyed|navigation/i.test(String(e.message))) problemas.push(`[${perfil}] ${rota}: ${String(e.message).slice(0, 160)}`);
      });
      await p.waitForLoadState('networkidle').catch(() => {});
      console.log(`✔ [${perfil}] ${rota}`);
    }
    await ctx.close();
  }
  await b.close();
  const unicos = [...new Set(problemas)];
  console.log(`\nGremlins: ${telas} tela(s), ${ACOES} ações cada · problemas: ${unicos.length}`);
  for (const x of unicos) console.log(`  ✘ ${x}`);
  process.exit(unicos.length ? 1 : 0);
})();
