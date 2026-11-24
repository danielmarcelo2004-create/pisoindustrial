// Regressão: nenhuma janela (role="dialog") pode cortar o conteúdo. Em cada tela, com cada perfil, no computador
// (1440px) e no celular (390px), clica nos botões que abrem janelas e confere se o conteúdo cabe na largura
// e se a janela não passa da tela. Ações sem volta (enviar, excluir, cancelar...) ficam de fora. Dados de demonstração.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:3000';
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// Dados para as janelas aparecerem: nota de medição, provisão, receita em aberto e extrato pendente
async function preparar() {
  const obra = (await admin.from('obras').select('id').eq('fluxo', 'A').limit(1).single()).data;
  const fin = (await admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single()).data.id;
  await admin.from('categorias').insert([{ nome: 'Medição (janelas)', tipo: 'receita' }]);
  await admin.from('notas_medicao').insert({ obra_id: obra.id, storage_path: `${obra.id}/medicoes/janelas-${Date.now()}.pdf`, nome_arquivo: 'medicao-com-um-nome-de-arquivo-bem-comprido-para-testar.pdf', numero: '99', sha256: '9'.repeat(64), valor: 123456.78, valor_liquido: 117283.94, data_emissao: hoje, criada_por: fin });
  await admin.from('provisoes').insert({ obra_id: obra.id, descricao: 'Provisão com uma descrição bem comprida para conferir a quebra de linha da janela (1/12)', vencimento: hoje, valor_estimado: 1234.56, created_by: fin });
  await admin.from('recebimentos').insert({ obra_id: obra.id, cliente: 'Cliente com nome comprido Engenharia e Construções Ltda', descricao: 'Receita para conferir janelas', valor: 4321, vencimento: hoje, status: 'aberto', created_by: fin });
  const conta = (await admin.from('contas_bancarias').select('id').eq('tipo', 'corrente').limit(1).single()).data.id;
  const imp = (await admin.from('extrato_importacoes').insert({ conta_id: conta, arquivo: 'janelas.ofx', created_by: fin }).select('id').single()).data.id;
  await admin.from('extrato_linhas').insert([
    { conta_id: conta, importacao_id: imp, data: hoje, valor: -987.65, tipo: 'DEBIT', descricao: 'PAGAMENTO DE BOLETO FORNECEDOR COM NOME BEM COMPRIDO LTDA', fitid: 'J1' },
    { conta_id: conta, importacao_id: imp, data: hoje, valor: 777.77, tipo: 'CREDIT', descricao: 'TED RECEBIDA CLIENTE QUALQUER', fitid: 'J2' },
  ]);
}
const TELAS = {
  financeiro: ['/', '/agenda', '/pagamentos', '/pagamentos/novo', '/recebimentos', '/contas-bancarias', '/contas-bancarias?ver=conciliada', '/provisoes', '/fundos-fixos', '/notas-medicao', '/notas-contabeis', '/fornecedores', '/categorias', '/compras', '/usuarios'],
  suprimentos: ['/pagamentos', '/pagamentos/novo', '/provisoes', '/recebimentos'],
  engenheiro: ['/', '/pagamentos', '/aprovacoes', '/recebimentos'],
};
const PROIBIDO = /^(sair|excluir|cancelar|desfazer e|rejeitar|remover|apagar|restaurar|confirmar|salvar|enviar|conciliar|cadastrar e|lançar receita e|registrar|baixar|arquivar|marcar|já foi|sim)/i;

(async () => {
  await preparar();
  const b = await chromium.launch();
  const vistas = new Set();
  const problemas = [];
  let janelas = 0;
  for (const [w, disp] of [[1440, 'computador'], [390, 'celular']]) {
    for (const [perfil, rotas] of Object.entries(TELAS)) {
      const p = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
      p.on('dialog', (d) => d.dismiss());
      await p.goto(BASE + '/login'); await p.fill('input[name=email]', `${perfil}@demo.local`); await p.fill('input[name=senha]', 'Demo-1234');
      await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
      for (const rota of rotas) {
        await p.goto(BASE + rota); await p.waitForLoadState('networkidle').catch(() => {});
        const textos = await p.locator('main button[type="button"]:visible').evaluateAll((bs) => bs.map((x) => (x.textContent || '').trim()).filter(Boolean));
        const unicos = [...new Set(textos)].filter((t) => !PROIBIDO.test(t)).slice(0, 30);
        for (const t of unicos) {
          const btn = p.locator('main button[type="button"]:visible', { hasText: t }).first();
          if (!(await btn.count())) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await p.waitForTimeout(150);
          const r = await p.evaluate((vw) => [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.offsetParent !== null || getComputedStyle(d).position === 'fixed').map((d) => {
            const c = d.firstElementChild || d; const box = c.getBoundingClientRect();
            return { nome: d.getAttribute('aria-label') || '(sem nome)', corta: c.scrollWidth > c.clientWidth + 1, fora: box.left < -1 || box.right > vw + 1 };
          }), w);
          for (const d of r) {
            janelas++;
            vistas.add(d.nome);
            if (d.corta || d.fora) problemas.push(`[${disp}] [${perfil}] ${rota} › "${t}" abre "${d.nome}": ${d.corta ? 'conteúdo cortado' : 'passa da tela'}`);
          }
          if (r.length || new URL(p.url()).pathname + new URL(p.url()).search !== rota) { await p.goto(BASE + rota); await p.waitForLoadState('networkidle').catch(() => {}); }
        }
        // Janelas que abrem pelo menu "Ações" da linha (abrir não altera nada; a ação só roda no botão da janela)
        for (const item of rota === '/pagamentos' ? ['Excluir lançamento', 'Voltar para em aberto', 'Alterar conta bancária'] : []) {
          const acoes = p.locator('main button[aria-haspopup="menu"]:visible');
          for (let i = 0; i < Math.min(await acoes.count(), 6); i++) {
            await acoes.nth(i).click({ timeout: 3000 }).catch(() => {});
            const mi = p.getByRole('menuitem', { name: item, exact: true });
            if (!(await mi.count())) { await p.keyboard.press('Escape'); await p.mouse.click(1, 1); continue; }
            await mi.click();
            await p.waitForTimeout(150);
            const r = await p.evaluate((vw) => [...document.querySelectorAll('[role="dialog"]')].map((d) => {
              const c = d.firstElementChild || d; const box = c.getBoundingClientRect();
              return { nome: d.getAttribute('aria-label') || '(sem nome)', corta: c.scrollWidth > c.clientWidth + 1, fora: box.left < -1 || box.right > vw + 1 || box.top < -1 || box.bottom > innerHeight + 1 };
            }), w);
            for (const d of r) {
              janelas++; vistas.add(d.nome);
              if (d.corta || d.fora) problemas.push(`[${disp}] [${perfil}] ${rota} › Ações › "${item}" abre "${d.nome}": ${d.corta ? 'conteúdo cortado' : 'passa da tela'}`);
            }
            await p.goto(BASE + rota); await p.waitForLoadState('networkidle').catch(() => {});
            break;
          }
        }
      }
      await p.close();
    }
  }
  await b.close();
  const unicos = [...new Set(problemas)];
  console.log(`Janelas conferidas: ${janelas} (${vistas.size} tipos: ${[...vistas].join(', ')}) · cortadas ou fora da tela: ${unicos.length}`);
  for (const x of unicos) console.log('  ✘ ' + x);
  process.exit(unicos.length ? 1 : 0);
})();
