// Conciliação bancária: leitor de OFX (formatos do Banco do Brasil e da Caixa) e sugestão automática.
// Dados inventados (nomes, contas e valores fictícios). Inclui os testes de regressão dos bugs já corrigidos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodificarOfx, lerOfx, normalizarBanco, normalizarConta } from "../src/lib/ofx.ts";
import { classificacaoProvavel, sugerir, tolerancia, type Candidato, type LinhaExtrato } from "../src/lib/conciliacao-sugestao.ts";

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
