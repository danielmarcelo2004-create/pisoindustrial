// Importação de vários extratos OFX de uma vez. Regressão: com a conta escolhida, um arquivo de OUTRA conta no lote
// era recusado só depois de os arquivos anteriores já terem sido importados (mensagem dizia "Nada foi importado").
// Agora todos os arquivos são conferidos antes de importar qualquer um. Extratos fictícios gerados aqui.
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
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

function ofx(nome, banco, agencia, conta, linhas) {
  const t = linhas.map(([d, v, memo, id]) => `<STMTTRN><TRNTYPE>${v < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d.replace(/-/g, '')}030000<TRNAMT>${v}<FITID>${id}<MEMO>${memo}</STMTTRN>`).join('');
  const txt = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>${banco}<BRANCHID>${agencia}<ACCTID>${conta}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261201<DTEND>20261231${t}</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20261231</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const p = path.join(DIR, nome);
  fs.writeFileSync(p, Buffer.from(txt, 'latin1'));
  return p;
}

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);

  const sufixo = String(Date.now()).slice(-6);
  const contaA = `7${sufixo}1`, contaB = `7${sufixo}2`;
  const a0 = ofx(`lote-a0-${sufixo}.ofx`, '0104', '0099', contaA, [['2026-12-01', -10, `PRIMEIRA ${sufixo}`, `A0${sufixo}`]]);
  const a1 = ofx(`lote-a1-${sufixo}.ofx`, '0104', '0099', contaA, [['2026-12-02', -20, `LOTE A1 ${sufixo}`, `A1${sufixo}`]]);
  const a2 = ofx(`lote-a2-${sufixo}.ofx`, '0104', '0099', contaA, [['2026-12-03', -30, `LOTE A2 ${sufixo}`, `A2${sufixo}`]]);
  const bx = ofx(`lote-b-${sufixo}.ofx`, '0104', '0099', contaB, [['2026-12-02', -40, `OUTRA CONTA ${sufixo}`, `B1${sufixo}`]]);

  // Cria a conta A com o primeiro extrato (importação sem conta escolhida)
  await p.goto(BASE + '/contas-bancarias'); await p.waitForLoadState('networkidle');
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Importar extrato OFX' }).first().click()]);
  await fc.setFiles(a0);
  await p.waitForURL(/importado=/, { timeout: 60000 });
  const conta = (await um(admin.from('contas_bancarias').select('id').eq('conta', contaA.replace(/^0+/, '')).limit(1)))[0];
  confere(conta, 'conta A não criada');
  const linhas = async (descricao) => (await um(admin.from('extrato_linhas').select('id').eq('descricao', descricao))).length;
  const enviar = async (arquivos) => {
    await p.goto(`${BASE}/contas-bancarias?conta=${conta.id}`); await p.waitForLoadState('networkidle');
    await p.getByRole('button', { name: /Ações da conta/ }).click(); // o import "desta conta" fica dentro desse menu
    await p.locator('form:has(input[name=conta_id]) input[name=arquivo]').setInputFiles(arquivos);
  };

  await passo('regressão: lote com arquivo de OUTRA conta é recusado inteiro (o arquivo válido antes dele não pode entrar)', async () => {
    await enviar([a1, bx]);
    await p.getByText(/outra conta/).waitFor({ timeout: 30000 });
    const msg = await p.getByText(/Nada foi importado/).first().innerText();
    confere(/outra conta/.test(msg), msg);
    confere(await linhas(`LOTE A1 ${sufixo}`) === 0, 'o arquivo A1 entrou mesmo com o lote recusado');
    confere(await linhas(`OUTRA CONTA ${sufixo}`) === 0, 'o arquivo da outra conta entrou');
  });

  await passo('lote com dois arquivos da própria conta importa os dois', async () => {
    await enviar([a1, a2]);
    await p.waitForURL(/importado=/, { timeout: 60000 });
    confere(await linhas(`LOTE A1 ${sufixo}`) === 1 && await linhas(`LOTE A2 ${sufixo}`) === 1, 'os dois arquivos deveriam ter entrado');
  });

  console.log(`\nImportação em lote: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
