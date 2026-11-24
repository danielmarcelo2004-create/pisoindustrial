// Conciliação bancária: leitor de OFX (formatos do Banco do Brasil e da Caixa) e sugestão automática.
// Dados inventados (nomes, contas e valores fictícios). Inclui os testes de regressão dos bugs já corrigidos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodificarOfx, lerOfx, normalizarBanco, normalizarConta } from "../src/lib/ofx.ts";
import { chaveMemo, classificacaoProvavel, sugerirReceitas, sugerirRecebimento, type ReceitaAberta, pareceEstorno, saidasParaEstorno, sugerir, sugerirEstornos, sugerirLancamento, sugerirTransferencias, tolerancia, type Candidato, type Historico, type LinhaExtrato, type SaidaEstornavel, type TransferenciaAberta } from "../src/lib/conciliacao-sugestao.ts";

// ---------- OFX ----------
const cab = "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n";
// Banco do Brasil: SGML sem tags de fechamento, uma por linha, acentos em Windows-1252, sem agência
const ofxBB =
  cab +
  `<OFX>\n<SIGNONMSGSRSV1>\n <SONRS>\n  <DTSERVER>20251204\n  <FI>\n   <ORG>Banco do Brasil S/A\n   <FID>001\n  </FI>\n </SONRS>\n</SIGNONMSGSRSV1>\n<BANKMSGSRSV1>\n <STMTTRNRS>\n  <STMTRS>\n` +
  `\t<BANKACCTFROM>\n\t <BANKID>001\n\t <ACCTID>12345-X \n\t <ACCTTYPE>CHECKING\n\t</BANKACCTFROM>\n\t<BANKTRANLIST>\n\t <DTSTART>20251031 \n\t <DTEND>20251130 \n` +
  `\t <STMTTRN>\n\t  <TRNTYPE>DEBIT \n\t  <DTPOSTED>20251104 \n\t  <TRNAMT>-1518.00 \n\t  <FITID>2025110411518 \n\t  <CHECKNUM>80401 \n\t  <MEMO>PAGAMENTO DE BOLETO - FULANO CONTABILIDADE \n\t </STMTTRN>\n` +
  `\t <STMTTRN>\n\t  <TRNTYPE>XFER \n\t  <DTPOSTED>20251105 \n\t  <TRNAMT>5000.00 \n\t  <FITID>2025110505000 \n\t  <MEMO>TRANSFERÊNCIA RECEBIDA - 05/11 14:28 CICRANO DE TAL \n\t </STMTTRN>\n` +
  `\t</BANKTRANLIST>\n    <LEDGERBAL>\n\t <BALAMT>-50.00\n\t <DTASOF>20251204\n    </LEDGERBAL>\n  </STMTRS>\n </STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n`;
// Caixa (arquivo 1): tudo numa linha, sem fechamento, MEMO; banco "0104"
const ofxCaixaMemo =
  cab +
  `\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>0104<BRANCHID>06353<ACCTID>0001112223334<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261001030000.000<DTEND>20261031030000.000` +
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261015030000.000<TRNAMT>-275.41<FITID>369639<CHECKNUM>369639<MEMO>DEBITO CAPITALIZACAO</STMTTRN>` +
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261015030000.000<TRNAMT>-275.41<FITID>369639<CHECKNUM>369639<MEMO>DEBITO CAPITALIZACAO</STMTTRN>` +
  `</BANKTRANLIST><LEDGERBAL><BALAMT>6634.74<DTASOF>20261026030000.000</LEDGERBAL><MKTGINFO>Gerenciador CAIXA</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
// Caixa (arquivo 2): com tags de fechamento e NAME no lugar de MEMO
const ofxCaixaName =
  cab +
  `\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0104</BANKID><BRANCHID>00068</BRANCHID><ACCTID>0001112223334</ACCTID></BANKACCTFROM><BANKTRANLIST><DTSTART>20251201030000.000</DTSTART><DTEND>20251231030000.000</DTEND>` +
  `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251204030000.000</DTPOSTED><TRNAMT>-2420.0</TRNAMT><FITID>041524</FITID><NAME>DEB PIX CHAVE</NAME></STMTTRN>` +
  `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251204030000.000</DTPOSTED><TRNAMT>-8.5</TRNAMT><FITID>041524</FITID><NAME>TAR PIX</NAME></STMTTRN>` +
  `</BANKTRANLIST><LEDGERBAL><BALAMT>309755.35</BALAMT><DTASOF>20251230030000.000</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const bytes1252 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

test("OFX do Banco do Brasil: sem fechamento, acentos em Windows-1252, sem agência, saldo", () => {
  const e = lerOfx(decodificarOfx(bytes1252(ofxBB)));
  assert.deepEqual([normalizarBanco(e.banco), e.agencia, normalizarConta(e.conta), e.inicio, e.fim, e.saldo, e.saldoEm], ["001", "", "12345X", "2025-10-31", "2025-11-30", -50, "2025-12-04"]);
  assert.equal(e.linhas.length, 2);
  assert.deepEqual(e.linhas[0], { data: "2025-11-04", valor: -1518, tipo: "DEBIT", descricao: "PAGAMENTO DE BOLETO - FULANO CONTABILIDADE", fitid: "2025110411518", documento: "80401" });
  assert.equal(e.linhas[1].descricao, "TRANSFERÊNCIA RECEBIDA - 05/11 14:28 CICRANO DE TAL", "acento lido certo");
});

test("OFX da Caixa nos dois formatos (MEMO numa linha só / NAME com fechamento); linhas idênticas legítimas são mantidas", () => {
  const a = lerOfx(decodificarOfx(bytes1252(ofxCaixaMemo)));
  assert.deepEqual([normalizarBanco(a.banco), normalizarConta(a.agencia), normalizarConta(a.conta), a.saldo, a.saldoEm], ["104", "6353", "1112223334", 6634.74, "2026-10-26"]);
  assert.equal(a.linhas.length, 2, "as duas capitalizações idênticas continuam");
  assert.equal(a.linhas[0].descricao, "DEBITO CAPITALIZACAO");
  const b = lerOfx(decodificarOfx(bytes1252(ofxCaixaName)));
  assert.deepEqual([normalizarConta(b.agencia), b.linhas.map((l) => [l.descricao, l.valor, l.fitid])], ["68", [["DEB PIX CHAVE", -2420, "041524"], ["TAR PIX", -8.5, "041524"]]]);
});

test("regressão: código de banco com 4 dígitos ('0104' da Caixa) vira '104', não '010'", () => {
  assert.equal(normalizarBanco("0104"), "104");
  assert.equal(normalizarBanco("1"), "001");
  assert.equal(normalizarBanco("001"), "001");
});

test("OFX inválido ou de cartão de crédito é recusado com mensagem clara", () => {
  assert.throws(() => lerOfx("isto não é um extrato"), /não é um extrato OFX/);
  assert.throws(() => lerOfx("<OFX><CCACCTFROM><ACCTID>1</CCACCTFROM></OFX>"), /conta bancária|cartão de crédito/);
});

// ---------- Sugestão ----------
const linha = (id: string, data: string, valor: number, descricao: string): LinhaExtrato => ({ id, data, valor, descricao, tipo: "DEBIT", situacao: "pendente", classificacao: null, observacao: null, encargos: null });
const cand = (id: string, valor: number, data: string, extra: Partial<Candidato> = {}): Candidato => ({
  chave: `pag:${id}`, tipo: "pagamento", id, pagamentoId: id, numero: 1, parcela: null, favorecido: "Fornecedor Qualquer", fornecedor: null, documento: null,
  descricao: "x", obra: "Obra", categoria: null, forma: "pix", contaId: null, contaNome: null, valor, data, pago: false, ...extra,
});
const sug = (m: Map<string, unknown>, id: string) => m.get(id) as { tipo: string; nivel?: string; candidato?: Candidato; diferenca?: number; classificacao?: string; motivo?: string } | undefined;

test("valor igual: mesma data = Encontramos; 18 dias = Quase lá; já paga só com valor exato", () => {
  const m = sugerir(
    [linha("a", "2025-12-04", -2420, "DEB PIX CHAVE"), linha("b", "2025-12-10", -8180, "PAG BOLETO IBC"), linha("c", "2025-12-23", -514, "PAG BOLETO IBC")],
    [cand("1", 2420, "2025-12-04"), cand("2", 8180, "2025-12-28"), cand("3", 514.5, "2025-12-23", { pago: true })],
  );
  assert.equal(sug(m, "a")?.nivel, "encontramos");
  assert.equal(sug(m, "b")?.nivel, "quase");
  assert.equal(sug(m, "c"), undefined, "conta já baixada com outro valor não é sugerida");
});

test("regressão: palavras do banco no nome do favorecido (ex.: 'Boleto Distante' × 'PAG BOLETO') não contam como nome conferido", () => {
  const m = sugerir([linha("a", "2025-12-10", -8180, "PAG BOLETO IBC")], [cand("1", 8180, "2025-12-28", { favorecido: "Boleto Distante" })]);
  assert.equal(sug(m, "a")?.nivel, "quase", "18 dias sem nome de verdade = Quase lá");
  assert.doesNotMatch(String(sug(m, "a")?.motivo), /nome confere/);
});

test("três PIX de mesmo valor no mesmo dia: cada um vai para a pessoa certa pelo nome; CNPJ do fornecedor também conta", () => {
  const m = sugerir(
    [linha("r", "2025-11-07", -982.28, "PIX - ENVIADO - 07/11 14:21 MARIA SILVA SOUZA"), linha("j", "2025-11-07", -982.28, "PIX - ENVIADO - 07/11 14:23 JOAO PEREIRA LIMA"), linha("k", "2025-11-04", -1518, "PAGAMENTO DE BOLETO 98765432000199")],
    [cand("joao", 982.28, "2025-11-20", { favorecido: "Joao Pereira Lima" }), cand("maria", 982.28, "2025-11-20", { favorecido: "Maria Silva Souza" }), cand("cnpj", 1518, "2025-11-25", { favorecido: "Escritório", documento: "98765432000199" })],
  );
  assert.equal(sug(m, "r")?.candidato?.id, "maria");
  assert.equal(sug(m, "j")?.candidato?.id, "joao");
  assert.equal(sug(m, "r")?.nivel, "encontramos");
  assert.equal(sug(m, "k")?.nivel, "encontramos", "CNPJ na descrição confere");
});

test("valor muito próximo (até 5%, mínimo R$ 1,00) vira Quase lá com a diferença; acima disso não é sugerido", () => {
  assert.equal(tolerancia(10), 1);
  assert.equal(tolerancia(7000), 350);
  const m = sugerir([linha("a", "2025-12-16", -7120, "DEB PIX"), linha("b", "2025-12-16", -9000, "DEB PIX")], [cand("1", 7000, "2025-12-16"), cand("2", 12000, "2025-12-16")]);
  assert.deepEqual([sug(m, "a")?.nivel, sug(m, "a")?.diferenca], ["quase", 120]);
  assert.equal(sug(m, "b"), undefined, "25% de diferença (12.000 × 9.000) não é sugerido");
});

test("conta bancária: despesa desta conta ou sem conta tem preferência; de outra conta, no máximo Quase lá (com aviso)", () => {
  const m = sugerir([linha("a", "2025-12-04", -100, "PIX")], [cand("outra", 100, "2025-12-04", { contaId: "B", contaNome: "Outra" })], "A");
  assert.equal(sug(m, "a")?.nivel, "quase");
  assert.match(String(sug(m, "a")?.motivo), /outra conta \(Outra\)/);
  const m2 = sugerir([linha("a", "2025-12-04", -100, "PIX")], [cand("outra", 100, "2025-12-04", { contaId: "B" }), cand("mesma", 100, "2025-12-05", { contaId: "A" })], "A");
  assert.equal(sug(m2, "a")?.candidato?.id, "mesma");
});

test("cada conta a pagar é sugerida para uma linha só", () => {
  const m = sugerir([linha("a", "2025-12-04", -50, "PIX"), linha("b", "2025-12-05", -50, "PIX")], [cand("1", 50, "2025-12-04")]);
  assert.equal(sug(m, "a")?.candidato?.id, "1");
  assert.equal(sug(m, "b"), undefined);
});

test("tipo provável: tarifa, aplicação, cartão (compra), empréstimo/capitalização e entrada", () => {
  assert.equal(classificacaoProvavel("TAR PIX", -8.5), "tarifa");
  assert.equal(classificacaoProvavel("MENSALIDADE CESTA SERVICO", -75), "tarifa");
  assert.equal(classificacaoProvavel("BB RENDE FÁCIL", -4814.71), "aplicacao");
  assert.equal(classificacaoProvavel("COMPRA COM CARTÃO - 03/11 18:38 LOJA", -25), "cartao");
  assert.equal(classificacaoProvavel("DEBITO CAPITALIZACAO", -263.82), "emprestimo");
  assert.equal(classificacaoProvavel("CRED PIX CHAVE", 708.33), "entrada");
  assert.equal(classificacaoProvavel("DEB PIX CHAVE", -2420), null);
});

test("regressão: pagamento de FATURA do cartão não recebe tipo (é conciliado com várias compras, não arquivado)", () => {
  assert.equal(classificacaoProvavel("PAGTO CARTÃO CRÉDITO - EMPRESARIAL ELO", -4301.61), null);
  assert.equal(classificacaoProvavel("PAGAMENTO CARTAO DE CREDITO", -100), null);
  const m = sugerir([linha("f", "2025-11-05", -4301.61, "PAGTO CARTÃO CRÉDITO - EMPRESARIAL ELO")], []);
  assert.equal(m.get("f"), undefined, "sem sugestão de arquivar: fica para buscar as compras");
});

test("nada é conciliado pela sugestão: ela só devolve propostas (sem efeito nas linhas)", () => {
  const l = linha("a", "2025-12-04", -2420, "DEB PIX CHAVE");
  const antes = JSON.stringify(l);
  sugerir([l], [cand("1", 2420, "2025-12-04")]);
  assert.equal(JSON.stringify(l), antes);
  assert.equal(l.situacao, "pendente");
});

// ---------- Novo lançamento (sugestão de descrição, categoria, centro de custo e fornecedor) ----------
const hist = (memo: string | null, favorecido: string, categoriaId: string, obraId: string, data: string, extra: Partial<Historico> = {}): Historico => ({ memo, favorecido, fornecedorId: null, fornecedor: null, documento: null, categoriaId, obraId, data, ...extra });
const categorias = [{ id: "c-imp", nome: "Impostos e taxas" }, { id: "c-sal", nome: "Salários" }, { id: "c-mat", nome: "Material para obra" }];

test("chave do texto do banco ignora data, hora e números (repete de um mês para outro)", () => {
  assert.equal(chaveMemo("SAQUE DIN ATM 06/11 10:16 SOP-MARIA QUITERIA"), chaveMemo("SAQUE DIN ATM 03/12 08:02 SOP-MARIA QUITERIA"));
  assert.notEqual(chaveMemo("SAQUE DIN ATM 06/11 SOP-MARIA"), chaveMemo("PIX ENVIADO 06/11 SOP-MARIA"));
});

test("novo lançamento: mesma descrição do banco já conciliada antes → repete categoria, centro de custo e fornecedor (a mais recente)", () => {
  const s = sugerirLancamento("SAQUE DIN ATM 06/11 10:16 SOP-MARIA QUITERIA", [
    hist("SAQUE DIN ATM 03/10 09:00 SOP-MARIA QUITERIA", "x", "c-mat", "obra-velha", "2026-10-03"),
    hist("SAQUE DIN ATM 03/11 09:00 SOP-MARIA QUITERIA", "x", "c-sal", "obra-1", "2026-11-03", { fornecedorId: "f-1" }),
  ], categorias);
  assert.deepEqual(s, { descricao: "SAQUE DIN ATM 06/11 10:16 SOP-MARIA QUITERIA", categoriaId: "c-sal", obraId: "obra-1", fornecedorId: "f-1", origem: "extrato" });
});

test("novo lançamento: nome do fornecedor na descrição do banco → usa o último lançamento dele", () => {
  const s = sugerirLancamento("PIX - ENVIADO - 07/11 14:21 VINICIUS EMPLACADORA", [hist(null, "Vinicius Emplacadora Ltda", "c-mat", "obra-2", "2026-10-01", { fornecedorId: "f-v" })], categorias);
  assert.deepEqual([s.categoriaId, s.obraId, s.fornecedorId, s.origem], ["c-mat", "obra-2", "f-v", "nome"]);
});

test("novo lançamento: sem histórico, palavras do banco apontam a categoria cadastrada (DARF → Impostos); sem nada, não inventa", () => {
  assert.deepEqual(sugerirLancamento("IMPOSTOS - RFB-DARF CODIGO 1234", [], categorias), { descricao: "IMPOSTOS - RFB-DARF CODIGO 1234", categoriaId: "c-imp", obraId: null, fornecedorId: null, origem: "palavra" });
  assert.deepEqual(sugerirLancamento("DEB PIX CHAVE", [], categorias), { descricao: "DEB PIX CHAVE", categoriaId: null, obraId: null, fornecedorId: null, origem: null });
  assert.equal(sugerirLancamento("DARF", [], [{ id: "x", nome: "Material" }]).categoriaId, null, "não sugere categoria que não existe");
});

// ---------- Transferência entre contas da empresa ----------
const transf = (id: string, contaOrigem: string, contaDestino: string, valor: number, data: string): TransferenciaAberta => ({ id, contaOrigem, contaDestino, outraConta: "", valor, data, descricao: "" });

test("transferência registrada numa conta é sugerida na outra: entrada no destino / saída na origem, mesmo valor, até 5 dias", () => {
  const entradas = [linha("e1", "2025-12-05", 2700, "CRED TRANSF"), linha("e2", "2025-12-20", 2700, "CRED TRANSF"), linha("s1", "2025-12-05", -2700, "ENVIO TRANSF")];
  const m = sugerirTransferencias(entradas, [transf("t1", "CAIXA", "BB", 2700, "2025-12-04")], "BB");
  assert.equal(m.get("e1")?.id, "t1", "entrada no destino, 1 dia depois");
  assert.equal(m.get("e2"), undefined, "16 dias depois não");
  assert.equal(m.get("s1"), undefined, "saída na conta de destino não é a mesma transferência");
  const m2 = sugerirTransferencias([linha("s", "2025-12-04", -2700, "ENVIO")], [transf("t1", "CAIXA", "BB", 2700, "2025-12-05")], "CAIXA");
  assert.equal(m2.get("s")?.id, "t1", "registrada a partir do destino: a saída na origem é sugerida");
  const m3 = sugerirTransferencias([linha("a", "2025-12-05", 2700, "X"), linha("b", "2025-12-05", 2700, "Y")], [transf("t1", "CAIXA", "BB", 2700, "2025-12-05")], "BB");
  assert.equal([m3.get("a"), m3.get("b")].filter(Boolean).length, 1, "uma transferência para uma linha só");
});

// ---------- Sem "arquivar" para o que é dinheiro de verdade ----------
test("nenhuma dica de arquivar: tarifa, aplicação, empréstimo, entrada e estorno têm destino (lançamento, transferência, recebimento, estorno)", () => {
  const ls = [
    linha("t", "2026-11-03", -8.5, "TAR PIX"),
    linha("a", "2026-11-03", -4814.71, "BB RENDE FÁCIL"),
    linha("r", "2026-11-04", 1000, "BB RENDE FACIL"),
    linha("e", "2026-11-04", -263.82, "DEBITO CAPITALIZACAO"),
    linha("c", "2026-11-05", 708.33, "CRED PIX CHAVE"),
    linha("x", "2026-11-05", 500, "PIX DEVOLVIDO FULANO"),
  ];
  const m = sugerir(ls, []);
  assert.deepEqual([...m.entries()].map(([k, v]) => `${k}:${v.tipo}`), ["a:aplicacao", "r:aplicacao"], "só aplicação/resgate ganham sugestão própria (conciliar na conta)");
});

test("tarifa e IOF sugerem a categoria de tarifas bancárias cadastrada (Novo lançamento)", () => {
  const cats = [...categorias, { id: "c-tar", nome: "Tarifas bancárias" }];
  assert.equal(sugerirLancamento("TAR PIX", [], cats).categoriaId, "c-tar");
  assert.equal(sugerirLancamento("MENSALIDADE CESTA SERVICO", [], cats).categoriaId, "c-tar");
  assert.equal(sugerirLancamento("IOF", [], cats).categoriaId, "c-tar");
});

// ---------- Aplicação / resgate automático (BB Rende Fácil) na própria conta ----------
test("Rende Fácil: aplicação e resgate são sugeridos para conciliar na própria conta; pagamento ou PIX comum não", () => {
  const ls = [linha("ap", "2026-11-03", -4814.71, "BB RENDE FÁCIL"), linha("rs", "2026-11-04", 1000, "BB RENDE FACIL"), linha("po", "2026-11-04", -50, "APLICACAO POUPANCA"), linha("px", "2026-11-04", -50, "PIX ENVIADO FULANO")];
  const m = sugerir(ls, []);
  assert.deepEqual([m.get("ap")?.tipo, m.get("rs")?.tipo, m.get("po")?.tipo, m.get("px")], ["aplicacao", "aplicacao", "aplicacao", undefined]);
  const cand = { chave: "pag:1", tipo: "pagamento", id: "1", pagamentoId: "1", numero: 1, parcela: null, favorecido: "X", fornecedor: null, documento: null, descricao: "", obra: "", categoria: null, forma: "pix", contaId: null, contaNome: null, valor: 4814.71, data: "2026-11-03", pago: false } as Candidato;
  assert.equal(sugerir([ls[0]], [cand]).get("ap")?.tipo, "conta", "conta a pagar de mesmo valor tem prioridade");
});

// ---------- Estorno em pares ----------
const saida = (id: string, data: string, valor: number, descricao: string, conciliadaCom: string | null = null): SaidaEstornavel => ({ id, data, valor, descricao, situacao: conciliadaCom ? "conciliada" : "pendente", conciliadaCom });

test("estorno: palavras de devolução/estorno", () => {
  for (const d of ["PIX DEVOLVIDO", "ESTORNO DE DEBITO", "TED DEVOLUCAO", "PAGAMENTO REJEITADO", "EST PIX", "Devolução PIX"]) assert.ok(pareceEstorno(d), d);
  for (const d of ["PIX RECEBIDO", "BB RENDE FACIL", "TRANSFERENCIA RECEBIDA", "DESTINO"]) assert.ok(!pareceEstorno(d), d);
});

test("estorno: a saída de mesmo valor até 10 dias antes (a mais próxima), uma por estorno; manual até 30 dias", () => {
  const ls = [linha("c1", "2026-11-10", 500, "PIX DEVOLVIDO"), linha("c2", "2026-11-10", 500, "PIX DEVOLVIDO"), linha("c3", "2026-11-10", 700, "CRED PIX")];
  const ss = [saida("s1", "2026-11-09", -500, "PIX ENVIADO A"), saida("s2", "2026-11-02", -500, "PIX ENVIADO B", "nº 7 · B"), saida("s3", "2026-11-11", -500, "DEPOIS"), saida("s4", "2026-10-15", -700, "VELHA")];
  const m = sugerirEstornos(ls, ss);
  assert.equal(m.get("c1")?.id, "s1", "a mais próxima");
  assert.equal(m.get("c2")?.id, "s2", "a outra saída (já conciliada) vai para o segundo estorno");
  assert.equal(m.get("c3"), undefined, "sem palavra de estorno não sugere sozinho");
  assert.deepEqual(saidasParaEstorno(ls[2], ss).map((s) => s.id), ["s4"], "manual: mesmo valor até 30 dias antes");
  assert.deepEqual(saidasParaEstorno(ls[0], ss).map((s) => s.id), ["s1", "s2"], "saída depois do estorno não entra");
  assert.deepEqual(saidasParaEstorno(linha("d", "2026-11-10", -500, "X"), ss), [], "saída não é estorno");
});

test("novo recebimento: mesma descrição do banco → centro de custo, categoria e cliente; cliente na descrição; medição", () => {
  const cats = [{ id: "r-med", nome: "Medição de obra" }, { id: "r-ap", nome: "Aporte" }];
  const h = [{ memo: "PIX RECEBIDO 05/11 14:28 CONSTRUTORA ALFA", cliente: "Construtora Alfa", categoriaId: "r-med", obraId: "o1", data: "2026-10-05" }];
  assert.deepEqual(sugerirRecebimento("PIX RECEBIDO 05/12 09:00 CONSTRUTORA ALFA", h, cats), { descricao: "PIX RECEBIDO 05/12 09:00 CONSTRUTORA ALFA", categoriaId: "r-med", obraId: "o1", cliente: "Construtora Alfa", origem: "extrato" });
  assert.equal(sugerirRecebimento("TED CONSTRUTORA ALFA SA", h, cats).origem, "nome");
  assert.equal(sugerirRecebimento("CRED MEDICAO 03", [], cats).categoriaId, "r-med");
  assert.deepEqual(sugerirRecebimento("CRED PIX CHAVE", [], cats), { descricao: "CRED PIX CHAVE", categoriaId: null, obraId: null, cliente: "", origem: null });
});

// ---------- Receita em aberto (Contas a receber) ----------
test("entrada × receita em aberto: valor total, ou total − imposto retido (medição); uma receita por entrada; até 45 dias", () => {
  const rec = (id: string, valor: number, retido: number, vencimento: string): ReceitaAberta => ({ id, numero: 1, cliente: "C", descricao: "", obra: "", valor, retido, vencimento });
  const ls = [linha("liq", "2026-12-10", 9400, "TED RECEBIDA"), linha("tot", "2026-12-10", 5000, "CRED TED"), linha("x", "2026-12-10", 777, "CRED"), linha("long", "2027-03-01", 5000, "CRED")];
  const m = sugerirReceitas(ls, [rec("med", 10000, 600, "2026-12-08"), rec("ap", 5000, 0, "2026-12-09")]);
  assert.deepEqual([m.get("liq")?.receita.id, m.get("liq")?.liquido], ["med", true], "líquido = total − retido");
  assert.deepEqual([m.get("tot")?.receita.id, m.get("tot")?.liquido], ["ap", false]);
  assert.equal(m.get("x"), undefined);
  assert.equal(m.get("long"), undefined, "receita já usada e longe da data");
  assert.equal(sugerirReceitas([linha("s", "2026-12-10", -5000, "SAIDA")], [rec("ap", 5000, 0, "2026-12-09")]).size, 0, "saída não é receita");
});
