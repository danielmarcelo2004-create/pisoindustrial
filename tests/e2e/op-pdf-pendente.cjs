// OP enviada sem o PDF oficial (a geração/anexo falhou no envio): a tela do pagamento avisa e "Gerar PDF da OP" gera e
// anexa de novo, sem duplicar. A OP é enviada direto pelo banco (sem passar pelo botão que gera o PDF). Dados fictícios.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
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

(async () => {
  const fin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await fin.auth.signInWithPassword({ email: 'financeiro@demo.local', password: 'Demo-1234' });
  const obra = (await um(admin.from('obras').select('id').eq('fluxo', 'C').limit(1)))[0] ?? (await um(admin.from('obras').select('id').limit(1)))[0];
  const ordemId = await um(fin.rpc('salvar_op', {
    p_id: null, p_obra_id: obra.id, p_favorecido: 'Prestador OP Sem PDF', p_cpf_cnpj: '123.456.789-09', p_descricao: 'Serviço de teste da OP sem PDF',
    p_vencimento: '2026-12-15', p_forma_pagamento: 'pix', p_dados_bancarios: 'Banco Teste\nChave PIX: teste@exemplo.com', p_observacoes: null,
    p_itens: [{ descricao: 'Serviço', unidade: 'un', quantidade: 2, valor_unitario: 150 }],
  }));
  const pagId = await um(fin.rpc('enviar_op', { p_id: ordemId }));
  const docs = async () => (await um(admin.from('documentos').select('id, nome_arquivo, ativo').eq('pagamento_id', pagId).eq('tipo', 'ordem_pagamento').eq('ativo', true)));
  confere((await docs()).length === 0, 'a OP deveria estar sem PDF');

  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);

  await passo('regressão: despesa de OP sem o PDF oficial mostra o aviso "PDF da OP pendente"', async () => {
    await p.goto(`${BASE}/pagamentos/${pagId}`); await p.waitForLoadState('networkidle');
    await p.locator('[data-pdf-op-pendente]').waitFor({ timeout: 15000 });
    confere(await p.getByRole('button', { name: 'Gerar PDF da OP' }).count() === 1, 'sem o botão');
  });

  await passo('"Gerar PDF da OP" gera e anexa o PDF oficial; o aviso some e nada é duplicado', async () => {
    await p.getByRole('button', { name: 'Gerar PDF da OP' }).click();
    await p.locator('[data-pdf-op-pendente]').waitFor({ state: 'detached', timeout: 30000 });
    const d = await docs();
    confere(d.length === 1 && /^OP-?.*\.pdf$|\.pdf$/.test(d[0].nome_arquivo), JSON.stringify(d));
    await p.goto(`${BASE}/pagamentos/${pagId}`); await p.waitForLoadState('networkidle');
    confere(await p.locator('[data-pdf-op-pendente]').count() === 0, 'o aviso continuou');
    confere((await docs()).length === 1, 'duplicou o PDF');
  });

  console.log(`\nPDF da OP pendente: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
