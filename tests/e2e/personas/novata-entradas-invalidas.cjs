// Persona "Joana, novata": não conhece as regras e faz o inesperado — campos vazios, valores negativos/zero/enormes, datas
// absurdas, CPF/CNPJ inválido, arquivo errado ou gigante, clique duplo, voltar no navegador, links de itens que não existem
// ou de outra obra, textos estranhos (aspas, <script>, emojis, 300 caracteres). O sistema deve responder com mensagem clara,
// sem tela quebrada, sem erro de JavaScript e sem gravar lixo. Dados fictícios; arquivos gerados em tempo de execução.
//
// Regras assumidas (ver o relatório): valor ≤ 0, não numérico ou acima do limite da coluna (numeric 14,2) é recusado com
// texto em português; vencimento/emissão absurdos (antes de 2000 ou mais de 10 anos à frente) não são gravados em silêncio;
// arquivo cujo conteúdo não é o do tipo da extensão (.pdf de texto) é recusado; CPF/CNPJ com dígito verificador errado só avisa
// (comentário em documento-fiscal.ts), mas tamanho errado bloqueia.
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { BASE, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSlAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function pdf(...linhas) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const pg = d.addPage([400, 300]);
  linhas.forEach((l, i) => pg.drawText(String(l), { x: 20, y: 260 - i * 18, size: 11, font: f }));
  return Buffer.from(await d.save());
}
const arq = (name, mimeType, buffer) => ({ name, mimeType, buffer });
/** Com mais de uma conta bancária cadastrada a escolha é obrigatória (com uma só ela já vem marcada). */
async function escolherConta(p) {
  const conta = await p.$('select[name=conta_bancaria_id]');
  if (conta && !(await conta.inputValue())) await p.selectOption('select[name=conta_bancaria_id]', { index: 1 });
}
const norm = (s) => s.replace(/ /g, ' ');
const textoMain = (p) => p.locator('main').innerText();

/** Texto estranho para colar nos campos: aspas, tags, SQL, emoji e acentos. */
const ESTRANHO = `Joana "D'Ávila" <b>negrito</b> <script>window.__xss=1</script> 😀 ';DROP TABLE pagamentos;--`;
const TRESCENTOS = Array.from({ length: 30 }, (_, i) => `palavra${String(i).padStart(2, '0')}`).join(' ').slice(0, 300); // 300 caracteres com espaços
const SEM_ESPACO = 'X'.repeat(300); // 300 caracteres sem quebra: costuma estourar o layout

rodar('Persona Joana (novata): entradas inválidas e comportamentos inesperados', async ({ b, passo, entrar }) => {
  const ID = marca('JOANA');
  const joana = await entrar('suprimentos');
  joana.on('dialog', (d) => d.accept());

  const contar = async (tabela, filtro) => {
    let q = admin.from(tabela).select('id', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(filtro ?? {})) q = k.startsWith('like:') ? q.like(k.slice(5), v) : q.eq(k, v);
    const { count, error } = await q; if (error) throw new Error(error.message);
    return count;
  };
  const pagamentosCom = (descricao) => contar('pagamentos', { descricao });
  /** Remove a validação nativa para o servidor responder (a mensagem que a Joana veria sem os campos obrigatórios). */
  const semValidacao = (p) => p.evaluate(() => document.querySelectorAll('form').forEach((f) => { f.noValidate = true; }));
  /** Lê alertas de erro/aviso visíveis na tela. */
  const avisos = (p) => p.locator('[role=alert], main form .text-xs.text-red-600, main form .text-xs.text-red-700').allInnerTexts().then((t) => t.join(' | '));
  const semTelaQuebrada = async (p, ctx) => {
    const t = await p.locator('body').innerText();
    confere(!/Application error|Internal Server Error|This page could not be found|Unhandled Runtime Error|digest/i.test(t.replace(/não foi encontrada/i, '')) || /404|não encontrad/i.test(t), `${ctx}: tela quebrada: ${t.slice(0, 160)}`);
  };

  async function preencherDespesa(p, { descricao, valor = '100,00', vencimento = somarDias(hoje, 7), favorecido = `Fornecedor ${ID}`, boleto, nota, obra = /Galp/, competencia }) {
    await ir(p, '/pagamentos/novo');
    const v = await p.$eval('select[name=obra_id]', (s, re) => [...s.options].find((x) => x.value && new RegExp(re).test(x.text))?.value, obra.source);
    await p.selectOption('select[name=obra_id]', v);
    await p.fill('input[name=favorecido]', favorecido);
    await p.fill('input[name=descricao]', descricao);
    await p.fill('input[name=valor]', valor);
    if (vencimento) await p.fill('input[name=vencimento]', vencimento);
    if (competencia) await p.fill('input[name=data_competencia]', competencia);
    if (boleto) await p.setInputFiles('input[name=boleto]', boleto);
    if (nota) await p.setInputFiles('input[name=nota_fiscal]', nota);
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await escolherConta(p);
  }
  const enviarDespesa = (p) => p.click('button:has-text("Cadastrar e encaminhar")');
  const BOLETO_OK = async () => arq(`boleto-${ID}.pdf`, 'application/pdf', await pdf('BOLETO FICTICIO', ID));

  // ───────────── Nova despesa: campos vazios, valores, datas ─────────────
  await passo('Nova despesa com tudo vazio: o navegador barra, a tela não quebra e nada é gravado', async () => {
    const antes = await contar('pagamentos', { favorecido: '' });
    await ir(joana, '/pagamentos/novo');
    await enviarDespesa(joana);
    await joana.waitForTimeout(800);
    confere(joana.url().endsWith('/pagamentos/novo'), 'saiu da tela com campos vazios');
    const invalidos = await joana.$$eval('form :invalid', (els) => els.length);
    confere(invalidos >= 3, `só ${invalidos} campos marcados como obrigatórios`);
    confere(await contar('pagamentos', { favorecido: '' }) === antes, 'gravou pagamento vazio');
    await semValidacao(joana); await enviarDespesa(joana);
    await joana.waitForSelector('[role=alert]', { timeout: 15000 });
    const msg = await avisos(joana);
    confere(/Selecione a obra|Informe|Escolha|Anexe/.test(msg), `mensagem pouco clara: "${msg}"`);
    confere(await contar('pagamentos', { favorecido: '' }) === antes, 'gravou pagamento vazio sem validação do navegador');
  });

  await passo('Nova despesa sem boleto nem nota: "Anexe um boleto ou nota fiscal…" e nada é gravado', async () => {
    const d = `Sem anexo ${ID}`;
    await preencherDespesa(joana, { descricao: d });
    await enviarDespesa(joana);
    await joana.getByText(/Anexe um boleto ou nota fiscal/).first().waitFor({ timeout: 15000 });
    confere(await pagamentosCom(d) === 0, 'gravou sem documento');
  });

  const valoresRuins = [['-100,00', 'negativo'], ['0,00', 'zero'], ['0', 'zero simples'], ['abc', 'texto'], ['12,345,67', 'vírgulas demais'], ['1.000.000.000.000,00', 'enorme (13 dígitos)'], ['99999999999999999999', 'gigante'], ['1e9', 'notação científica'], ['10,999', 'três casas']];
  await passo('Valores absurdos (negativo, zero, texto, enorme): recusados com mensagem em português e sem gravar — no navegador e no servidor', async () => {
    const falhas = [];
    for (const [valor, rotulo] of valoresRuins) {
      const d = `Valor ${rotulo} ${ID}`;
      await preencherDespesa(joana, { descricao: d, valor, boleto: await BOLETO_OK() });
      await semValidacao(joana); await enviarDespesa(joana);
      await joana.waitForTimeout(1500);
      const msg = await avisos(joana);
      const gravou = await pagamentosCom(d);
      if (gravou) falhas.push(`${rotulo} (${valor}) GRAVOU`);
      else if (!/valor|Nada foi cadastrado/i.test(msg) || /overflow|numeric|violates|PGRST|syntax/i.test(msg)) falhas.push(`${rotulo} (${valor}): mensagem "${msg.slice(0, 120)}"`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('Valor enorme com a validação do navegador ligada: o campo avisa e o envio não sai', async () => {
    const d = `Valor navegador ${ID}`;
    await preencherDespesa(joana, { descricao: d, valor: '-5', boleto: await BOLETO_OK() });
    await enviarDespesa(joana);
    await joana.waitForTimeout(600);
    confere(joana.url().endsWith('/pagamentos/novo'), 'enviou valor negativo');
    confere(await joana.$eval('input[name=valor]', (i) => !i.validity.valid), 'o campo valor aceitou "-5"');
    confere(await pagamentosCom(d) === 0, 'gravou valor negativo');
  });

  await passo('Datas absurdas: vencimento muito no passado (1900, 0001) avisa; muito no futuro (2999, 9999) não pode ser gravado em silêncio — recusa clara ou aviso antes de enviar', async () => {
    const falhas = [];
    for (const venc of ['1900-01-01', '0001-01-01']) {
      await preencherDespesa(joana, { descricao: `Data ${venc} ${ID}`, vencimento: venc, boleto: await BOLETO_OK() });
      await joana.waitForTimeout(900);
      const aviso = await joana.locator('[data-avisos-lancamento]').innerText().catch(() => '');
      if (!/já passou|data inválida|absurd/i.test(aviso)) falhas.push(`vencimento ${venc}: sem nenhum aviso (aviso: "${aviso.replace(/\s+/g, ' ').slice(0, 80)}")`);
    }
    for (const venc of ['2999-12-31', '9999-12-31']) {
      const d = `Data ${venc} ${ID}`;
      await preencherDespesa(joana, { descricao: d, vencimento: venc, boleto: await BOLETO_OK() });
      await joana.waitForTimeout(900);
      const aviso = await joana.locator('[data-avisos-lancamento]').innerText().catch(() => '');
      await enviarDespesa(joana);
      await joana.waitForTimeout(3000);
      const gravou = await pagamentosCom(d);
      const msg = await avisos(joana);
      const avisou = /absurd|muito (distante|longe)|confira a data|data inválida|vencimento inválido|mais de \d+ (anos|meses)|distante/i.test(aviso + ' ' + msg);
      if (gravou && !avisou) falhas.push(`vencimento ${venc}: gravou sem recusar e sem avisar (aviso: "${aviso.replace(/\s+/g, ' ').slice(0, 60)}")`);
    }
    const d = `Competência 1900 ${ID}`;
    await preencherDespesa(joana, { descricao: d, competencia: '1900-01-01', boleto: await BOLETO_OK() });
    await joana.waitForTimeout(900);
    if (!/meses de hoje|competência/i.test(await joana.locator('[data-avisos-lancamento]').innerText().catch(() => ''))) falhas.push('competência de 1900 sem nenhum aviso');
    for (const rota of ['/agenda', '/pagamentos?periodo=todos', '/']) { await ir(joana, rota); await semTelaQuebrada(joana, rota); }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('Vencimento no passado e em fim de semana: apenas avisa (e sugere o próximo dia útil), sem travar', async () => {
    await preencherDespesa(joana, { descricao: `Passado ${ID}`, vencimento: '2026-01-03', boleto: await BOLETO_OK() }); // sábado
    await joana.waitForTimeout(900);
    const aviso = await joana.locator('[data-avisos-lancamento]').innerText();
    confere(/já passou/.test(aviso) && /Usar \d\d\/\d\d/.test(aviso), 'sem aviso de data passada/dia útil: ' + aviso.replace(/\s+/g, ' '));
  });

  // ───────────── Arquivos errados ─────────────
  await passo('Arquivo errado: .txt, .exe e .zip no lugar de PDF são recusados com "Formato não aceito" e nada é gravado', async () => {
    for (const [nome, tipo] of [['anotacoes.txt', 'text/plain'], ['programa.exe', 'application/octet-stream'], ['tudo.zip', 'application/zip'], ['planilha.xlsx', 'application/vnd.ms-excel']]) {
      const d = `Arquivo ${nome} ${ID}`;
      await preencherDespesa(joana, { descricao: d, boleto: arq(nome, tipo, Buffer.from('conteúdo qualquer')) });
      await enviarDespesa(joana);
      await joana.getByText(/Formato não aceito/).first().waitFor({ timeout: 15000 });
      confere(await pagamentosCom(d) === 0, `${nome}: gravou pagamento`);
    }
  });

  await passo('Arquivo gigante (26 MB): recusado com "muito grande (máximo 25 MB)" sem derrubar a tela nem gravar', async () => {
    const d = `Gigante ${ID}`;
    const grande = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF')]);
    await preencherDespesa(joana, { descricao: d, boleto: arq('enorme.pdf', 'application/pdf', grande) });
    await enviarDespesa(joana);
    await joana.getByText(/muito grande|máximo 25 MB/).first().waitFor({ timeout: 90000 });
    confere(await pagamentosCom(d) === 0, 'gravou com arquivo gigante');
    await semTelaQuebrada(joana, 'arquivo gigante');
  });

  await passo('Arquivo "falso": texto salvo com extensão .pdf não pode virar boleto (conteúdo não é PDF)', async () => {
    const d = `PDF falso ${ID}`;
    await preencherDespesa(joana, { descricao: d, boleto: arq('falso.pdf', 'application/pdf', Buffer.from('isto é só um texto, não um PDF de verdade')) });
    await enviarDespesa(joana);
    await joana.waitForTimeout(4000);
    const gravou = await pagamentosCom(d);
    const msg = await avisos(joana);
    confere(!gravou && /PDF|arquivo|inválid|corromp/i.test(msg), `o sistema aceitou um .pdf que não é PDF (gravou=${gravou}, mensagem="${msg.slice(0, 100)}")`);
  });

  await passo('Notas estranhas como nota fiscal (PDF corrompido, XML quebrado, XML de outro tipo): não derrubam o cadastro e avisam', async () => {
    for (const [nome, tipo, corpo] of [['nf-quebrada.pdf', 'application/pdf', Buffer.from('%PDF-1.4 lixo lixo lixo')], ['nf-quebrada.xml', 'application/xml', Buffer.from('<nfeProc><NFe><infNFe>')], ['qualquer.xml', 'application/xml', Buffer.from('<?xml version="1.0"?><outra>coisa</outra>')]]) {
      const d = `Nota ${nome} ${ID}`;
      await preencherDespesa(joana, { descricao: d, nota: arq(nome, tipo, corpo) });
      await enviarDespesa(joana);
      await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 }).catch(async () => { throw new Error(`${nome}: não concluiu (${await avisos(joana)})`); });
      await semTelaQuebrada(joana, nome);
      if (!nome.endsWith('.pdf')) confere(/não foi reconhecido|aviso=/.test(decodeURIComponent(joana.url())) || /não foi reconhecido/.test(await joana.locator('body').innerText()), `${nome}: sem aviso de que a nota não foi lida`);
    }
  });

  // ───────────── Clique duplo e voltar ─────────────
  const c_voltar = {};
  await passo('Clique duplo em "Cadastrar e encaminhar": só um pagamento é criado', async () => {
    const d = `Clique duplo ${ID}`;
    await preencherDespesa(joana, { descricao: d, boleto: await BOLETO_OK() });
    await joana.locator('button:has-text("Cadastrar e encaminhar")').dblclick();
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 });
    await joana.waitForTimeout(2500);
    confere(await pagamentosCom(d) === 1, `${await pagamentosCom(d)} pagamentos criados`);
    c_voltar.pag = joana.url();
    c_voltar.desc = d;
  });

  await passo('Voltar no navegador depois de cadastrar: a tela volta íntegra, avisa de possível duplicidade e reenviar não passa em branco', async () => {
    await joana.goBack();
    await joana.waitForLoadState('networkidle');
    await semTelaQuebrada(joana, 'voltar');
    confere(/pagamentos\/novo/.test(joana.url()), 'voltar não retornou ao formulário: ' + joana.url());
    // reenviar o mesmo formulário (preenchendo de novo): o aviso de duplicidade aparece
    await preencherDespesa(joana, { descricao: c_voltar.desc, boleto: await BOLETO_OK() });
    await joana.waitForTimeout(2500);
    confere(/Possível lançamento duplicado/.test(await joana.locator('[data-avisos-lancamento]').innerText().catch(() => '')), 'sem aviso de possível duplicidade');
  });

  await passo('Sair e voltar no navegador: a página protegida não reaparece sem login', async () => {
    const m = await entrar('suprimentos');
    await ir(m, '/pagamentos');
    await m.getByRole('button', { name: 'Sair' }).first().click();
    await m.waitForURL(/\/login/);
    await m.goBack();
    await m.waitForTimeout(1500);
    const url = m.url();
    const corpo = await m.locator('body').innerText();
    confere(/\/login/.test(url) || !/Contas a pagar/.test(corpo), `página protegida visível depois de sair: ${url}`);
    await m.close();
  });

  await passo('Login com senha errada ou campos vazios: mensagem clara, sem erro de JavaScript', async () => {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    p.on('pageerror', (e) => { throw e; });
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', 'suprimentos@demo.local'); await p.fill('input[name=senha]', 'senha-errada');
    await p.click('button:has-text("Entrar")');
    await p.getByText('E-mail ou senha incorretos.').waitFor();
    await p.fill('input[name=email]', '<script>alert(1)</script>"\'');
    await p.click('button:has-text("Entrar")');
    await p.waitForTimeout(500);
    confere(p.url().includes('/login'), 'saiu do login com e-mail inválido');
    await ctx.close();
  });

  // ───────────── Links de itens que não existem / de outra obra ─────────────
  await passo('Links inexistentes (UUID que não existe, lixo no endereço): 404 ou volta ao início, nunca tela de erro', async () => {
    const falso = '00000000-0000-4000-8000-000000000000';
    const falhas = [];
    for (const rota of [`/pagamentos/${falso}`, '/pagamentos/abc', `/pagamentos/${falso}/editar`, `/pagamentos/${falso}/parcelas/${falso}`, `/ops/${falso}`, `/ops/${falso}/editar`, '/ops/lixo', `/fornecedores/${falso}`, '/fornecedores/xyz', `/compras/lancar/${falso}`, '/compras/lancar/lixo', `/obras/${falso}`, `/recebimentos/${falso}`, `/documentos/${falso}`, `/usuarios/${falso}`, `/pagamentos/${encodeURIComponent('<script>alert(1)</script>')}`]) {
      const r = await joana.goto(BASE + rota);
      const status = r.status();
      const corpo = await joana.locator('body').innerText();
      if (status >= 500) falhas.push(`${rota}: HTTP ${status}`);
      else if (/Application error|Unhandled Runtime Error|Internal Server Error/.test(corpo)) falhas.push(`${rota}: tela de erro`);
      else if (status === 200 && !joana.url().includes('sem-permissao') && new URL(joana.url()).pathname === rota.split('?')[0] && !/não encontrad|404/i.test(corpo)) falhas.push(`${rota}: 200 sem nada a mostrar`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('Lixo nos filtros do endereço (/compras e /fornecedores): a tela abre, sem erro 500', async () => {
    const falhas = [];
    joana.on('pageerror', (e) => falhas.push(`erro de JavaScript em ${joana.url().slice(0, 90)}: ${e.message.slice(0, 60)}`));
    const lixos = ['"', "'", '%', '%%%', ',', '(', ')', '*', '\\', 'a,b.c:d', '"; drop table nf_itens;--', '<script>window.__xss=1</script>', 'a"b', "a'b", '😀', 'x'.repeat(400), '.', ':', 'not.eq.1', ')),or(descricao.ilike.%'];
    for (const l of lixos) {
      for (const rota of [`/compras?material=${encodeURIComponent(l)}`, `/compras?fornecedor=${encodeURIComponent(l)}`, `/compras?cidade=${encodeURIComponent(l)}`, `/fornecedores?busca=${encodeURIComponent(l)}`]) {
        const r = await joana.goto(BASE + rota);
        const corpo = await joana.locator('body').innerText();
        if (r.status() >= 500 || /Application error|Unhandled Runtime Error|Internal Server Error|something went wrong/i.test(corpo)) falhas.push(`${rota.slice(0, 60)} → ${r.status()}`);
      }
    }
    for (const q of ['de=31/12/2026', 'de=9999-99-99&ate=0000-00-00', 'de=2026-12-31&ate=2026-01-01', 'uf=XX', 'uf=%27', 'obra=nao-e-uuid', 'obra=%27%20or%201=1', 'grupo=%00', 'grupo=' + 'z'.repeat(300), 'material=&fornecedor=&obra=&cidade=&uf=&de=&ate=']) {
      const r = await joana.goto(BASE + '/compras?' + q);
      const corpo = await joana.locator('body').innerText();
      if (r.status() >= 500 || /Application error|Unhandled Runtime Error|Internal Server Error/i.test(corpo)) falhas.push(`/compras?${q.slice(0, 50)} → ${r.status()}`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  // ───────────── Textos estranhos ─────────────
  await passo('Texto estranho (aspas, <script>, SQL, emoji) na descrição e no favorecido: grava como texto, não executa nada, tela íntegra', async () => {
    const TXT = `${ESTRANHO} ${ID}`;
    await preencherDespesa(joana, { descricao: TXT, favorecido: ESTRANHO.slice(0, 120), boleto: await BOLETO_OK() });
    await enviarDespesa(joana);
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 });
    const id = joana.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const pg = (await admin.from('pagamentos').select('descricao, favorecido').eq('id', id).single()).data;
    confere(pg.descricao === TXT, 'descrição foi alterada ao gravar: ' + pg.descricao);
    confere(await joana.evaluate(() => window.__xss) === undefined, 'o <script> foi executado');
    confere(await joana.locator('main script, main b').count() === 0, 'HTML do texto virou elemento na tela');
    confere((await textoMain(joana)).includes('<b>negrito</b>'), 'o texto não aparece literal na tela');
    confere(await pagamentosCom(TXT) === 1, 'o texto com SQL gerou ' + (await pagamentosCom(TXT)) + ' pagamentos');
    confere((await contar('pagamentos')) > 5, 'a tabela pagamentos foi esvaziada!');
    for (const rota of ['/pagamentos?periodo=todos', '/agenda', `/pagamentos?busca=${encodeURIComponent(TXT)}`]) { await ir(joana, rota); await semTelaQuebrada(joana, rota); }
  });

  await passo('300 caracteres colados na descrição (com e sem espaços): grava inteiro e o texto cabe na tela do celular, sem estourar o layout', async () => {
    const cel = await entrar('suprimentos', 390);
    const falhas = [];
    for (const texto of [TRESCENTOS, SEM_ESPACO]) {
      await preencherDespesa(joana, { descricao: texto, boleto: await BOLETO_OK() });
      await enviarDespesa(joana);
      await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 });
      const id = joana.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
      confere((await admin.from('pagamentos').select('descricao').eq('id', id).single()).data.descricao === texto, 'descrição truncada');
      for (const rota of [`/pagamentos/${id}`, '/pagamentos?periodo=todos']) {
        await ir(cel, rota);
        const r = await cel.evaluate((trecho) => {
          const donos = [...document.querySelectorAll('main *')].filter((el) => el.children.length === 0 && (el.textContent || '').includes(trecho));
          const estouros = donos.filter((el) => { const b = el.getBoundingClientRect(); return b.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1; }).length;
          return { achou: donos.length, estouros, pagina: document.documentElement.scrollWidth - innerWidth };
        }, texto.slice(0, 20));
        if (r.pagina > 1) falhas.push(`${texto === SEM_ESPACO ? 'sem espaços' : 'com espaços'} em ${rota}: página passa ${r.pagina}px`);
        if (r.estouros) falhas.push(`${texto === SEM_ESPACO ? 'sem espaços' : 'com espaços'} em ${rota}: o texto estoura a largura (${r.estouros} elemento(s))`);
      }
    }
    await cel.close();
    confere(!falhas.length, falhas.join(' ;; '));
  });

  // ───────────── Solicitação de OP ─────────────
  async function novaOP(p, { descricao = `OP Joana ${ID}`, favorecido = `Fornecedor ${ID}`, itens, vencimento = somarDias(hoje, 10), desconto, pix = true, categoria = true, parcelas }) {
    await ir(p, '/pagamentos/novo');
    await p.getByLabel('Forma de pagamento').selectOption('pix');
    await p.waitForSelector('input[name=chave_pix]');
    const v = await p.$eval('select[name=obra_id]', (s) => [...s.options].find((x) => x.value && /Galp/.test(x.text))?.value);
    await p.selectOption('select[name=obra_id]', v);
    if (vencimento !== null) await p.fill('input[name=vencimento]', vencimento);
    await p.fill('input[name=favorecido]', favorecido);
    await p.fill('input[name=descricao]', descricao);
    if (pix) { await p.fill('input[name=banco]', 'Banco Fictício'); await p.fill('input[name=chave_pix]', 'chave@teste.local'); }
    if (categoria) { await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click(); }
    const conta = await p.$('select[name=conta_bancaria_id]');
    if (conta && !(await conta.inputValue())) await p.selectOption('select[name=conta_bancaria_id]', { index: 1 });
    for (const [i, it] of itens.entries()) {
      if (i > 0) await p.getByRole('button', { name: '+ Adicionar item' }).click();
      await p.getByLabel(`Descrição do item ${i + 1}`).fill(it[0]);
      await p.getByLabel(`Unidade do item ${i + 1}`).fill(it[1] ?? '');
      await p.getByLabel(`Quantidade do item ${i + 1}`).fill(it[2]);
      await p.getByLabel(`Valor unitário do item ${i + 1}`).fill(it[3]);
    }
    if (desconto !== undefined) await p.getByLabel('Desconto').fill(desconto);
    if (parcelas) await p.fill('input[name=parcelas]', String(parcelas));
  }
  const opsCom = (descricao) => contar('ordens_pagamento', { descricao });
  const botaoEnviarOP = (p) => p.locator('button:has-text("Salvar e enviar")');

  await passo('OP com itens inválidos (quantidade 0/negativa/texto, valor negativo, enorme): mensagem por item, nada enviado nem gravado', async () => {
    const casos = [
      ['quantidade zero', ['Cimento', 'SC', '0', '10,00']], ['quantidade negativa', ['Cimento', 'SC', '-3', '10,00']], ['quantidade texto', ['Cimento', 'SC', 'muitos', '10,00']],
      ['valor negativo', ['Cimento', 'SC', '1', '-10,00']], ['valor texto', ['Cimento', 'SC', '1', 'caro']],
      ['valor enorme', ['Cimento', 'SC', '1', '99999999999999999999,00']], ['total estoura a coluna', ['Cimento', 'SC', '1000000000', '1000000000,00']],
    ];
    const falhas = [];
    for (const [rotulo, item] of casos) {
      const d = `OP ${rotulo} ${ID}`;
      await novaOP(joana, { descricao: d, itens: [item] });
      await semValidacao(joana); await botaoEnviarOP(joana).click();
      await joana.waitForTimeout(2500);
      const msg = await avisos(joana);
      const env = await opsCom(d);
      const pag = await pagamentosCom(d);
      if (pag) falhas.push(`${rotulo}: virou PAGAMENTO`);
      else if (env && (await um(admin.from('ordens_pagamento').select('status').eq('descricao', d))).some((o) => o.status !== 'em_elaboracao')) falhas.push(`${rotulo}: OP enviada`);
      if (!msg || /overflow|numeric|violates|PGRST|syntax|NaN|null value/i.test(msg)) falhas.push(`${rotulo}: mensagem "${msg.slice(0, 100)}"`);
      if (env) falhas.push(`${rotulo}: gravou OP/rascunho com valor inválido`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('OP: campos obrigatórios faltando (sem vencimento, sem chave PIX, sem categoria, sem favorecido): cada falta gera mensagem própria', async () => {
    const falhas = [];
    const casos = [
      ['sem vencimento', { vencimento: '' }, /vencimento/i], ['sem chave PIX', { pix: false }, /PIX|banco/i], ['sem categoria', { categoria: false }, /categoria/i], ['sem favorecido', { favorecido: '' }, /favorecido/i],
    ];
    for (const [rotulo, extra, re] of casos) {
      const d = `OP ${rotulo} ${ID}`;
      await novaOP(joana, { descricao: d, itens: [['Areia', 'M3', '1', '10,00']], ...extra, vencimento: extra.vencimento ?? undefined });
      if (extra.vencimento === '') await joana.fill('input[name=vencimento]', '');
      await semValidacao(joana); await botaoEnviarOP(joana).click();
      await joana.waitForTimeout(2500);
      const msg = await avisos(joana);
      const pag = await pagamentosCom(d);
      if (pag) falhas.push(`${rotulo}: enviou`);
      else if (!re.test(msg)) falhas.push(`${rotulo}: mensagem "${msg.slice(0, 100)}"`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('OP: desconto maior que o total, desconto negativo e parcelas que não somam o total são recusados com mensagem', async () => {
    const falhas = [];
    for (const [rotulo, extra, re] of [['desconto maior', { desconto: '500,00' }, /desconto/i], ['desconto negativo', { desconto: '-5' }, /desconto/i], ['desconto texto', { desconto: 'dez' }, /desconto/i]]) {
      const d = `OP ${rotulo} ${ID}`;
      await novaOP(joana, { descricao: d, itens: [['Areia', 'M3', '1', '100,00']], ...extra });
      await semValidacao(joana); await botaoEnviarOP(joana).click();
      await joana.waitForTimeout(2500);
      const msg = await avisos(joana);
      if (await pagamentosCom(d)) falhas.push(`${rotulo}: enviou`);
      else if (!re.test(msg)) falhas.push(`${rotulo}: mensagem "${msg.slice(0, 100)}"`);
    }
    const d = `OP parcelas erradas ${ID}`;
    await novaOP(joana, { descricao: d, itens: [['Areia', 'M3', '1', '100,00']], parcelas: 3 });
    await joana.getByLabel('Valor da parcela 2').fill('1,00');
    confere(/precisa ser igual ao total/.test(await joana.locator('main').innerText()), 'sem aviso de parcelas que não somam o total');
    await semValidacao(joana); await botaoEnviarOP(joana).click();
    await joana.waitForTimeout(2500);
    if (await pagamentosCom(d)) falhas.push('parcelas que não somam: enviou');
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('OP: quantidade de parcelas absurda (0, -2, 500, texto) é corrigida ou recusada, nunca grava 500 parcelas', async () => {
    for (const n of ['0', '-2', '500', 'abc']) {
      const d = `OP parcelas ${n} ${ID}`;
      await novaOP(joana, { descricao: d, itens: [['Areia', 'M3', '1', '100,00']] });
      await joana.evaluate((v) => { const i = document.querySelector('input[name=parcelas]'); i.removeAttribute('min'); i.removeAttribute('max'); i.type = 'text'; }, n);
      await joana.fill('input[name=parcelas]', n);
      await semValidacao(joana); await botaoEnviarOP(joana).click();
      await joana.waitForTimeout(3000);
      const pg = (await admin.from('pagamentos').select('id').eq('descricao', d)).data ?? [];
      if (pg.length) {
        const np = await contar('parcelas', { pagamento_id: pg[0].id });
        confere(np <= 60, `${n}: gravou ${np} parcelas`);
      }
      await semTelaQuebrada(joana, `parcelas ${n}`);
    }
  });

  await passo('OP com texto estranho em itens e favorecido (emoji, <script>, aspas): envia, PDF oficial é gerado e nada é executado', async () => {
    const d = `OP ${ESTRANHO}`;
    await novaOP(joana, { descricao: d, favorecido: `Forn ${ESTRANHO}`.slice(0, 190), itens: [[ESTRANHO.slice(0, 160), 'UN', '2', '10,50'], [TRESCENTOS.slice(0, 180), 'M²', '1,5', '3,33']] });
    await botaoEnviarOP(joana).click();
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 }).catch(async () => { throw new Error('não enviou: ' + (await avisos(joana))); });
    const id = joana.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const docs = await um(admin.from('documentos').select('tipo').eq('pagamento_id', id));
    confere(docs.some((x) => x.tipo === 'ordem_pagamento'), 'o PDF da OP não foi gerado com texto estranho (aviso: ' + decodeURIComponent(joana.url()).slice(-160) + ')');
    confere(await joana.evaluate(() => window.__xss) === undefined, 'script executado');
    // 2 x 10,50 + 1,5 x 3,33 = 21,00 + 4,995 → 4,99 (arredonda por item em centavos)
    const v = Number((await admin.from('pagamentos').select('valor').eq('id', id).single()).data.valor);
    confere(Math.abs(v - 26) < 0.02, `valor do pagamento ${v}`);
  });

  await passo('OP: clique duplo em "Salvar e enviar" cria uma só OP e um só pagamento', async () => {
    const d = `OP clique duplo ${ID}`;
    await novaOP(joana, { descricao: d, itens: [['Brita', 'M3', '2', '80,00']] });
    await botaoEnviarOP(joana).dblclick();
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 });
    await joana.waitForTimeout(3000);
    confere(await opsCom(d) === 1, `${await opsCom(d)} OPs`);
    confere(await pagamentosCom(d) === 1, `${await pagamentosCom(d)} pagamentos`);
  });

  await passo('OP: enviar_op disparado duas vezes ao mesmo tempo (duas abas) gera um só pagamento', async () => {
    const d = `OP corrida ${ID}`;
    await novaOP(joana, { descricao: d, itens: [['Brita', 'M3', '2', '80,00']] });
    await joana.click('button:has-text("Salvar rascunho"):not(:has-text("anexar"))');
    await joana.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar/, { timeout: 60000 });
    const id = joana.url().match(/ops\/([0-9a-f-]{36})/)[1];
    const sup = await cliente('suprimentos');
    const rs = await Promise.all([sup.rpc('enviar_op', { p_id: id }), sup.rpc('enviar_op', { p_id: id }), sup.rpc('enviar_op', { p_id: id })]);
    confere(rs.filter((r) => !r.error).length === 1, `${rs.filter((r) => !r.error).length} envios aceitos`);
    confere((await admin.from('pagamentos').select('id').eq('ordem_id', id)).data.length === 1, 'mais de um pagamento para a mesma OP');
    c_voltar.opId = id;
  });

  await passo('OP: voltar no navegador para o rascunho já enviado e tentar "Salvar e enviar" de novo não cria segundo pagamento nem altera a OP', async () => {
    await joana.goto(BASE + `/ops/${c_voltar.opId}/editar`);
    await joana.waitForLoadState('networkidle');
    await semTelaQuebrada(joana, 'editar OP enviada');
    const antes = await contar('pagamentos', { ordem_id: c_voltar.opId });
    const podeEnviar = await botaoEnviarOP(joana).count();
    if (podeEnviar) {
      await joana.getByLabel('Descrição do item 1').fill('Alterado depois de enviada');
      await botaoEnviarOP(joana).click();
      await joana.waitForTimeout(3000);
      confere(/enviada|não pode|já foi|alterar|bloquead|permiss/i.test(await avisos(joana)) || joana.url().includes('/ops/'), 'sem mensagem clara ao reenviar OP já enviada');
    }
    confere(await contar('pagamentos', { ordem_id: c_voltar.opId }) === antes, 'segundo pagamento criado');
    const itens = await um(admin.from('ordem_itens').select('descricao').eq('ordem_id', c_voltar.opId));
    confere(!itens.some((i) => i.descricao === 'Alterado depois de enviada'), 'OP enviada foi alterada');
  });

  await passo('OP: anexo gigante (>10 MB), .txt, .exe e arquivo vazio no rascunho: recusados com mensagem e nada gravado', async () => {
    const d = `OP anexos ${ID}`;
    await novaOP(joana, { descricao: d, itens: [['Brita', 'M3', '2', '80,00']] });
    await joana.getByRole('button', { name: 'Salvar rascunho para anexar' }).click();
    await joana.locator('label:has-text("Anexar comprovante")').waitFor({ timeout: 30000 });
    const entrada = joana.locator('label:has-text("Anexar comprovante") input[type=file]');
    const id = (await um(admin.from('ordens_pagamento').select('id').eq('descricao', d)))[0].id;
    await entrada.setInputFiles(arq('grande.pdf', 'application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 0x20)])));
    await joana.getByText('O arquivo passa de 10 MB.').waitFor({ timeout: 15000 });
    await entrada.setInputFiles(arq('notas.txt', 'text/plain', Buffer.from('texto')));
    await joana.getByText('Envie um PDF, PNG ou JPG.').waitFor();
    await entrada.setInputFiles(arq('app.exe', 'application/x-msdownload', Buffer.from('MZ')));
    await joana.getByText('Envie um PDF, PNG ou JPG.').waitFor();
    await entrada.setInputFiles(arq('vazio.pdf', 'application/pdf', Buffer.alloc(0)));
    await joana.waitForTimeout(1500);
    const n = (await um(admin.from('ordem_anexos').select('id, nome_arquivo').eq('ordem_id', id)));
    confere(n.length === 0, `anexos gravados: ${n.map((x) => x.nome_arquivo)}`);
    await semTelaQuebrada(joana, 'anexo inválido');
  });

  await passo('OP: .pdf que na verdade é texto, anexado ao rascunho, não pode ser gravado como PDF', async () => {
    const d = `OP anexo falso ${ID}`;
    await novaOP(joana, { descricao: d, itens: [['Brita', 'M3', '2', '80,00']] });
    await joana.getByRole('button', { name: 'Salvar rascunho para anexar' }).click();
    await joana.locator('label:has-text("Anexar comprovante")').waitFor({ timeout: 30000 });
    await joana.locator('label:has-text("Anexar comprovante") input[type=file]').setInputFiles(arq('falso.pdf', 'application/pdf', Buffer.from('não sou um pdf')));
    await joana.waitForTimeout(2500);
    const id = (await um(admin.from('ordens_pagamento').select('id').eq('descricao', d)))[0].id;
    const n = (await um(admin.from('ordem_anexos').select('id').eq('ordem_id', id))).length;
    confere(n === 0, 'o texto com extensão .pdf foi gravado como anexo da OP');
  });

  // ───────────── Fornecedor ─────────────
  const fornNovo = async (p, campos) => {
    await ir(p, '/fornecedores/novo');
    for (const [k, v] of Object.entries(campos)) {
      if (k === 'uf') await p.selectOption('select[name=uf]', v); else await p.fill(`input[name=${k}], textarea[name=${k}]`, v);
    }
  };
  const fornecedoresCom = (nome) => contar('fornecedores', { nome });

  await passo('Fornecedor: nome vazio, CPF/CNPJ com tamanho errado e letras: mensagens claras e nada gravado', async () => {
    const antes = await contar('fornecedores');
    await fornNovo(joana, { cpf_cnpj: '12345' });
    await semValidacao(joana); await joana.click('button:has-text("Cadastrar fornecedor")');
    await joana.getByText('Informe o nome / razão social.').waitFor();
    await joana.fill('input[name=nome]', `Forn tamanho ${ID}`);
    await joana.click('button:has-text("Cadastrar fornecedor")');
    await joana.getByText(/CPF deve ter 11 dígitos e CNPJ 14 dígitos/).first().waitFor();
    confere(await fornecedoresCom(`Forn tamanho ${ID}`) === 0, 'gravou com documento de 5 dígitos');
    await joana.fill('input[name=cpf_cnpj]', 'abcdefghijk');
    await joana.click('button:has-text("Cadastrar fornecedor")');
    await joana.waitForTimeout(2000);
    const gravou = await fornecedoresCom(`Forn tamanho ${ID}`);
    const msg = await avisos(joana);
    confere(!gravou || /CPF|CNPJ|inválid/i.test(msg), 'CPF/CNPJ só com letras foi aceito em silêncio e o documento descartado');
    confere(await contar('fornecedores') === antes + gravou, 'contagem de fornecedores inesperada');
  });

  await passo('Fornecedor: CPF/CNPJ com dígito verificador errado avisa na tela (aviso que não trava); CPF válido não avisa', async () => {
    await fornNovo(joana, { nome: `Forn dv ${ID}`, cpf_cnpj: '111.444.777-00' });
    await joana.waitForTimeout(500);
    confere(/CPF inválido/.test(await joana.locator('[data-avisos-lancamento]').innerText()), 'sem aviso de CPF inválido');
    await joana.fill('input[name=cpf_cnpj]', '12.345.678/0001-00');
    await joana.waitForTimeout(500);
    confere(/CNPJ inválido/.test(await joana.locator('[data-avisos-lancamento]').innerText()), 'sem aviso de CNPJ inválido');
    await joana.fill('input[name=cpf_cnpj]', '111.444.777-35'); // CPF válido (fictício)
    await joana.waitForTimeout(500);
    confere(!/inválido/.test(await joana.locator('[data-avisos-lancamento]').innerText().catch(() => '')), 'avisou de CPF válido');
  });

  await passo('Fornecedor: CNPJ repetido é recusado com "Já existe um cadastro"; clique duplo em cadastrar cria um só', async () => {
    const cnpj = String(10000000000000 + (Date.now() % 80000000000000));
    await fornNovo(joana, { nome: `Forn dup ${ID}`, cpf_cnpj: cnpj });
    await joana.locator('button:has-text("Cadastrar fornecedor")').dblclick();
    await joana.waitForURL(/\/fornecedores\/[0-9a-f-]{36}\?criado=1/, { timeout: 30000 });
    await joana.waitForTimeout(2000);
    confere(await contar('fornecedores', { cpf_cnpj: cnpj }) === 1, 'clique duplo criou dois fornecedores com o mesmo documento');
    await fornNovo(joana, { nome: `Forn dup2 ${ID}`, cpf_cnpj: cnpj });
    await joana.click('button:has-text("Cadastrar fornecedor")');
    await joana.getByText(/Já existe um cadastro/).waitFor({ timeout: 15000 });
    confere(await fornecedoresCom(`Forn dup2 ${ID}`) === 0, 'gravou o repetido');
  });

  await passo('Fornecedor: clique duplo sem CNPJ não pode criar dois cadastros do mesmo nome', async () => {
    const nome = `Forn sem doc ${ID}`;
    await fornNovo(joana, { nome });
    await joana.locator('button:has-text("Cadastrar fornecedor")').dblclick();
    await joana.waitForURL(/\/fornecedores\/[0-9a-f-]{36}\?criado=1/, { timeout: 30000 });
    await joana.waitForTimeout(2500);
    confere(await fornecedoresCom(nome) === 1, `${await fornecedoresCom(nome)} fornecedores com o mesmo nome criados`);
  });

  await passo('Fornecedor: e-mail sem sentido, telefone com letras e texto estranho: o e-mail inválido é recusado; o resto grava como texto', async () => {
    const nome = `Forn ${ESTRANHO}`.slice(0, 150);
    await fornNovo(joana, { nome, email: 'isto não é e-mail', telefone: 'ligar de manhã!!', cidade: '<i>Cidade</i> 😀', observacoes: TRESCENTOS });
    await semValidacao(joana); await joana.click('button:has-text("Cadastrar fornecedor")');
    await joana.waitForTimeout(3000);
    const f = (await admin.from('fornecedores').select('email, nome').eq('nome', nome)).data ?? [];
    confere(await joana.evaluate(() => window.__xss) === undefined, 'script executado');
    await semTelaQuebrada(joana, 'fornecedor estranho');
    confere(!f.length || !f.some((x) => x.email === 'isto não é e-mail'), 'e-mail "isto não é e-mail" foi gravado no fornecedor');
    if (f.length) { await ir(joana, '/fornecedores?busca=' + encodeURIComponent('<script>')); await semTelaQuebrada(joana, 'busca com <script>'); }
  });

  // ───────────── Compras: lançar NF manual com entradas inválidas ─────────────
  const prepararNF = async () => {
    const d = `NF Joana ${marca('x')}`;
    await preencherDespesa(joana, { descricao: d, nota: arq(`nota-${ID}.pdf`, 'application/pdf', await pdf('NOTA FISCAL FICTICIA', d)) });
    await enviarDespesa(joana);
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 });
    const id = joana.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const doc = (await um(admin.from('documentos').select('id').eq('pagamento_id', id).eq('tipo', 'nota_fiscal')))[0].id;
    return { id, doc };
  };
  const formNF = async (p, doc, { emitente = `Emitente ${ID}`, emissao = '2026-11-20', frete, chave, itens }) => {
    await ir(p, `/compras/lancar/${doc}`);
    await p.fill('input[name=emitente_nome]', emitente);
    if (emissao) await p.fill('input[name=data_emissao]', emissao);
    if (frete !== undefined) await p.fill('input[name=valor_frete]', frete);
    if (chave !== undefined) await p.fill('input[name=chave]', chave);
    for (const [i, it] of itens.entries()) {
      if (i > 0) await p.getByRole('button', { name: '+ Adicionar item' }).click();
      await p.getByLabel(`Descrição ${i + 1}`).fill(it[0]); await p.getByLabel(`Unidade ${i + 1}`).fill(it[1] ?? '');
      await p.getByLabel(`Quantidade ${i + 1}`).fill(it[2]); await p.getByLabel(`Preço ${i + 1}`).fill(it[3]);
    }
  };
  const enviarNF = async (p) => { await semValidacao(p); await p.click('button:has-text("Registrar itens")'); await p.waitForTimeout(2500); };
  const nfDoPag = async (id) => (await admin.from('nf_notas').select('id, valor_total, valor_frete').eq('pagamento_id', id).eq('ativa', true).maybeSingle()).data;

  await passo('Lançar NF manual com itens inválidos (quantidade 0/negativa/texto, preço negativo/texto/enorme, sem item): mensagem clara e nada gravado', async () => {
    const { id, doc } = await prepararNF();
    const falhas = [];
    const casos = [
      ['quantidade 0', [['Tubo', 'UN', '0', '10']], /quantidade/i], ['quantidade negativa', [['Tubo', 'UN', '-2', '10']], /quantidade/i], ['quantidade texto', [['Tubo', 'UN', 'duas', '10']], /quantidade/i],
      ['preço negativo', [['Tubo', 'UN', '1', '-10']], /valor unitário|preço/i], ['preço texto', [['Tubo', 'UN', '1', 'barato']], /valor unitário|preço/i],
      ['total enorme', [['Tubo', 'UN', '1000000000', '1000000000']], /.+/], ['sem descrição', [['', 'UN', '1', '10']], /ao menos um item/i],
    ];
    for (const [rotulo, itens, re] of casos) {
      await formNF(joana, doc, { itens });
      await enviarNF(joana);
      const msg = await avisos(joana);
      if (await nfDoPag(id)) { falhas.push(`${rotulo}: GRAVOU a nota`); await admin.from('nf_notas').delete().eq('pagamento_id', id); }
      else if (!re.test(msg) || /overflow|numeric|violates|PGRST|NaN/i.test(msg)) falhas.push(`${rotulo}: mensagem "${msg.slice(0, 100)}"`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('Lançar NF manual: sem fornecedor, sem data, data absurda (0001/9999), chave com letras, frete negativo: recusados e não gravados', async () => {
    const { id, doc } = await prepararNF();
    const falhas = [];
    const casos = [
      ['sem fornecedor', { emitente: '' }, /fornecedor/i], ['sem data', { emissao: '' }, /data de emiss/i],
      ['data 0001', { emissao: '0001-01-01' }, /data/i], ['data 9999', { emissao: '9999-12-31' }, /data/i],
      ['chave com letras', { chave: 'abc-não-é-chave' }, /chave/i], ['chave curta', { chave: '12345' }, /chave/i],
      ['frete negativo', { frete: '-500,00' }, /frete/i], ['frete texto', { frete: 'grátis' }, /frete/i],
    ];
    for (const [rotulo, extra, re] of casos) {
      await formNF(joana, doc, { itens: [['Tubo PVC', 'UN', '2', '10']], ...extra });
      await enviarNF(joana);
      const msg = await avisos(joana);
      const nf = await nfDoPag(id);
      if (nf) { falhas.push(`${rotulo}: GRAVOU a nota (total ${nf.valor_total})`); await admin.from('nf_notas').delete().eq('pagamento_id', id); }
      else if (!re.test(msg) || /overflow|numeric|violates|PGRST|NaN/i.test(msg)) falhas.push(`${rotulo}: mensagem "${msg.slice(0, 100)}"`);
    }
    confere(!falhas.length, falhas.join(' ;; '));
  });

  await passo('Lançar NF manual: clique duplo em "Registrar itens" cria uma só nota e termina no pagamento', async () => {
    const { id, doc } = await prepararNF();
    await formNF(joana, doc, { itens: [['Tubo PVC 50mm', 'UN', '2', '10']] });
    await joana.locator('button:has-text("Registrar itens")').dblclick();
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 30000 });
    await joana.waitForTimeout(2000);
    confere((await admin.from('nf_notas').select('id').eq('pagamento_id', id).eq('ativa', true)).data.length === 1, 'mais de uma nota para o mesmo documento');
    confere(await contar('nf_itens', { nota_id: (await nfDoPag(id)).id }) === 1, 'itens duplicados');
  });

  await passo('Lançar NF manual com texto estranho nos itens: grava, aparece literal em Compras e nada é executado', async () => {
    const { id, doc } = await prepararNF();
    await formNF(joana, doc, { itens: [[ESTRANHO + ' ' + ID, 'UN', '1', '12,34']] });
    await enviarNF(joana);
    await joana.waitForURL(/nf=lancada/, { timeout: 20000 }).catch(() => {});
    confere(await nfDoPag(id), 'não gravou: ' + (await avisos(joana)));
    await ir(joana, '/compras?material=' + encodeURIComponent(ID));
    confere((await textoMain(joana)).includes('<b>negrito</b>'), 'o texto não aparece literal em Compras');
    confere(await joana.evaluate(() => window.__xss) === undefined, 'script executado em Compras');
    await joana.locator('table.tabela tbody tr a').first().click();
    await joana.waitForLoadState('networkidle');
    await semTelaQuebrada(joana, 'detalhe do material');
    confere(await joana.evaluate(() => window.__xss) === undefined, 'script executado no detalhe');
  });

  // ───────────── Permissão cruzada: itens de outra obra ─────────────
  await passo('Engenheiro tenta abrir, pelo endereço, pagamento, documento e OP de outra obra: 404/bloqueio, sem vazar nada', async () => {
    const obras = await um(admin.from('obras').select('id, nome'));
    const feira = obras.find((o) => /Feira/.test(o.nome)).id;
    const eng = await cliente('engenheiro');
    const minhas = (await eng.from('obras').select('id')).data.map((o) => o.id);
    confere(!minhas.includes(feira), 'o engenheiro enxerga a obra da Feira: o cenário não vale');
    // um pagamento e um documento na obra da Feira, criados pela Joana
    const d = `Obra B ${ID}`;
    await preencherDespesa(joana, { descricao: d, obra: /Piso Industrial/, boleto: await BOLETO_OK() });
    await enviarDespesa(joana);
    await joana.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 });
    const pagId = joana.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const docId = (await um(admin.from('documentos').select('id').eq('pagamento_id', pagId)))[0].id;
    const opId = (await um(admin.from('ordens_pagamento').select('id').limit(1)))[0]?.id;
    const e = await entrar('engenheiro');
    const falhas = [];
    for (const rota of [`/pagamentos/${pagId}`, `/pagamentos/${pagId}/editar`, `/documentos/${docId}`, ...(opId ? [`/ops/${opId}`] : [])]) {
      const r = await e.goto(BASE + rota);
      const corpo = await e.locator('body').innerText();
      if (r.status() === 200 && new URL(e.url()).pathname === rota && /Obra B|Piso Industrial|Fornecedor/.test(corpo) && !/não encontrad|404|sem permissão/i.test(corpo)) falhas.push(`${rota}: abriu (${r.status()})`);
    }
    const lista = await ir(e, '/pagamentos?periodo=todos').then(() => e.locator('main').innerText());
    if (lista.includes(d)) falhas.push('a lista do engenheiro mostra o pagamento da outra obra');
    const direto = await eng.from('pagamentos').select('id').eq('id', pagId);
    if (direto.data?.length) falhas.push('o banco devolveu o pagamento da outra obra ao engenheiro');
    await e.close();
    confere(!falhas.length, falhas.join(' ;; '));
  });

  // ───────────── Celular ─────────────
  await passo('Celular 390px: formulários e telas que a Joana abre não ganham rolagem lateral (nova despesa, OP, fornecedor, lançar NF, listas)', async () => {
    const m = await entrar('suprimentos', 390);
    m.on('dialog', (d) => d.accept());
    const { doc } = await prepararNF().catch(() => ({ doc: null }));
    const falhas = [];
    const telas = ['/pagamentos/novo', '/fornecedores/novo', '/fornecedores', '/compras', '/pagamentos?periodo=todos', ...(doc ? [`/compras/lancar/${doc}`] : [])];
    for (const url of telas) {
      await ir(m, url);
      const r = await m.evaluate(() => ({ pagina: document.documentElement.scrollWidth - innerWidth, areas: [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((w) => `${w.tagName}.${String(w.className).slice(0, 30)} ${w.scrollWidth}>${w.clientWidth}`) }));
      if (r.pagina > 1) falhas.push(`${url}: página passa ${r.pagina}px`);
      if (r.areas.length) falhas.push(`${url}: rolagem lateral em ${r.areas.join(' | ')}`);
    }
    // formulário de OP com 3 itens no celular
    await ir(m, '/pagamentos/novo');
    await m.getByLabel('Forma de pagamento').selectOption('pix');
    await m.getByRole('button', { name: '+ Adicionar item' }).click(); await m.getByRole('button', { name: '+ Adicionar item' }).click();
    const r = await m.evaluate(() => ({ pagina: document.documentElement.scrollWidth - innerWidth, areas: [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((w) => `${w.tagName} ${w.scrollWidth}>${w.clientWidth}`) }));
    if (r.pagina > 1 || r.areas.length) falhas.push(`formulário de OP no celular: página ${r.pagina}px, áreas ${r.areas.join(' | ')}`);
    await m.close();
    confere(!falhas.length, falhas.join(' ;; '));
  });
});
