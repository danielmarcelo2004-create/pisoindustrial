// Testes da leitura de nota fiscal a partir do texto do OCR. Uso: node --test tests/nota/
import { test } from "node:test";
import assert from "node:assert/strict";
import { lerNotaTexto } from "../../src/lib/ocr/nota-fiscal.ts";
import { montarLinhas } from "../../src/lib/pdf-texto.ts";

const DANFE = `
DANFE - DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONICA
CONCRETEIRA BAIANA LTDA
CNPJ 12.345.678/0001-90 Ilha de Itaparica - BA
Nº 4.567 Série 1
DATA DA EMISSÃO 28/10/2026
CHAVE DE ACESSO
2926 1112 3456 7800 0190 5500 1000 0045 6710 0004 5678
DADOS DO PRODUTO / SERVIÇO
CÓD. DESCRIÇÃO DO PRODUTO NCM CST CFOP UN QUANT. V.UNIT. V.TOTAL
CONC30 CONCRETO USINADO FCK 30 MPA 38245000 5101 M3 32,0000 592,50 18.960,00
BOMB Serviço de bombeamento de concreto 00000000 5933 SV 1,0000 850,00 850,00
ADIT Aditivo plastificante para concreto 38244000 5101 L 20,5000 14,80 303,40
DESTINATÁRIO CNPJ 04.602.232/0001-70 CONSTRUTORA PARCERIA PROJ. E CONST. LTDA
VALOR TOTAL DOS PRODUTOS 20.113,40
VALOR DO FRETE 350,00
VALOR TOTAL DA NOTA 20.463,40
`;

test('lê cabeçalho, chave e itens de uma nota nítida', () => {
  const r = lerNotaTexto(DANFE);
  assert.equal(r.confiavel, true, r.motivos.join('; '));
  assert.equal(r.nota.emitente_cnpj, '12.345.678/0001-90');
  assert.equal(r.nota.data_emissao, '2026-10-28');
  assert.equal(r.nota.numero, '4567');
  assert.equal(r.nota.chave, '29261112345678000190550010000045671000045678');
  assert.equal(r.itens.length, 3);
  assert.equal(r.itens[0].codigo, 'CONC30');
  assert.equal(r.itens[0].descricao, 'CONCRETO USINADO FCK 30 MPA');
  assert.equal(r.itens[0].ncm, '38245000');
  assert.equal(r.itens[0].unidade, 'M3');
  assert.equal(r.itens[0].quantidade, 32);
  assert.equal(r.itens[0].valor_unitario, 592.5);
  assert.equal(r.itens[0].valor_total, 18960);
  assert.equal(r.nota.valor_produtos, 20113.4);
});

test('não considera confiável quando uma linha não fecha a conta', () => {
  const ruim = DANFE.replace('20,5000 14,80 303,40', '20,5000 14,80 999,99');
  const r = lerNotaTexto(ruim);
  assert.equal(r.confiavel, false);
  assert.ok(r.motivos.some((m) => /duvidosa|não bate/.test(m)), r.motivos.join('; '));
});

test('não considera confiável quando o total de produtos não confere', () => {
  const r = lerNotaTexto(DANFE.replace('20.113,40', '20.000,00'));
  assert.equal(r.confiavel, false);
  assert.ok(r.motivos.some((m) => /não bate/.test(m)));
});

test('texto sem itens não é confiável', () => {
  const r = lerNotaTexto('Recibo de pagamento sem produtos\nCNPJ 12.345.678/0001-90');
  assert.equal(r.confiavel, false);
  assert.ok(r.motivos.some((m) => /nenhum item/.test(m)));
});

test("regressão: DANFE em PDF com texto ('EMITENTE <nome> CNPJ') traz o nome do emitente (sem ele a nota não era gravada na Inteligência de Compras)", () => {
  const r = lerNotaTexto(["DANFE", "NF-e Nº 000.012.345 Série 1 EMISSÃO 03/11/2026", "EMITENTE Aço Forte Distribuidora LTDA CNPJ 12.345.678/0001-90", "PRODUTOS / SERVIÇOS", "Vergalhão CA-50 12mm NCM 72142000 UN 100,00 10,00 1.000,00", "VALOR TOTAL DOS PRODUTOS R$ 1.000,00", "VALOR TOTAL DA NOTA R$ 1.000,00"].join("\n"));
  assert.equal(r.nota.emitente_nome, "Aço Forte Distribuidora LTDA");
  assert.equal(r.itens[0].descricao, "Vergalhão CA-50 12mm", "sem o rótulo NCM na descrição");
  assert.ok(r.confiavel);
});

// DANFE em PDF com texto (layout em grade, emissor que grava o texto fora de ordem). Dados fictícios.
const DANFE_GRADE = `RECEBEMOS DE MATERIAIS FICTICIOS DE CONSTRUCAO LTDA (FL01) NF-e
Nº. 123456
SÉRIE 1
Identificação do Emitente
DANF-e
MATERIAIS FICTICIOS DE CONSTRUCAO LTDA (FL01)
0 - ENTRADA
1 - SAÍDA 1 CHAVE DE ACESSO
2926 0711 2223 3300 0181 5500 1000 1234 5610 0000 0010
INSCRIÇÃO ESTADUAL INSC. EST. DO SUBST. TRIBUTARIO CNPJ Protocolo de Autorização(Data e Hora)
01.234.567 11222333000181 129260000000000 28/07/2026 15:54:43
NOME/RAZÃO SOCIAL COD.CLIENTE CNPJ/CPF DATA DA EMISSÃO
CONSTRUTORA PARCERIA PROJ E CONST.LTDA 106273 04.602.232/0001-70 28/07/2026
BASE DE CÁLCULO DE ICMS VALOR DO ICMS BASE DE CÁLCULO DO ICMS ST. VALOR DO ICMS SUBSTITUIÇÃO VALOR TOTAL DOS PRODUTOS
0,00 0,00 0,00 0,00 1.170,54
VALOR DO FRETE VALOR DO SEGURO VALOR DO DESCONTO OUTRAS DESPESAS ACESSÓRIAS VALOR DO IPI VALOR TOTAL DA NOTA
0,00 R$ 0,00 0,00 0,00 0,00 1.170,54
Código DESCRIÇÃO DO PRODUTO/SERVIÇO NCM/SH CST CFOP UND QTD V. UN. V. TOTAL BC. ICMS V. ICMS V. IPI ALIQ. ALIQ.
528884 DUCHA HIGIENICA CROMADA FICTICIA 1.00 84818019 041 5922 UN 9 130,06 1.170,54 0,00 0,00 0,00 0,00 0,00
27043.6 REF.DA COR: .
FIM DOS PRODUTOS`;

test('regressão: DANFE em grade com quantidade inteira, CNPJ só com dígitos e impostos depois do total era recusada ("nenhum item lido")', () => {
  const r = lerNotaTexto(DANFE_GRADE);
  assert.deepEqual(r.motivos, []);
  assert.equal(r.confiavel, true);
  assert.equal(r.nota.emitente_cnpj, "11.222.333/0001-81");
  assert.equal(r.nota.emitente_nome, "MATERIAIS FICTICIOS DE CONSTRUCAO LTDA (FL01)");
  assert.equal(r.nota.chave, "29260711222333000181550010001234561000000010", 'o "1" de SAÍDA não entra na chave');
  assert.equal(r.nota.valor_produtos, 1170.54, "total de produtos na linha de baixo, não o primeiro 0,00");
  assert.equal(r.nota.valor_total, 1170.54);
  assert.equal(r.itens.length, 1);
  assert.deepEqual([r.itens[0].codigo, r.itens[0].descricao, r.itens[0].ncm, r.itens[0].unidade, r.itens[0].quantidade, r.itens[0].valor_unitario, r.itens[0].valor_total], ["528884", "DUCHA HIGIENICA CROMADA FICTICIA 1.00", "84818019", "UN", 9, 130.06, 1170.54]);
});

test('regressão: o texto do PDF fora de ordem é remontado pela posição (a linha do item saía partida em três)', () => {
  // y cresce para cima; o emissor grava código/NCM/valores antes da descrição
  const p = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y] });
  const texto = montarLinhas([
    p("528884", 20, 300), p("84818019", 300, 300), p("5922", 380, 300.5), p("UN", 420, 300), p("9", 450, 300), p("130,06", 480, 300), p("1.170,54", 530, 300),
    p("FIM DOS PRODUTOS", 250, 250),
    p("041", 350, 299.4), p("DUCHA HIGIENICA CROMADA FICTICIA", 70, 300),
    p("Código DESCRIÇÃO", 20, 320),
  ]);
  assert.deepEqual(texto.split("\n"), ["Código DESCRIÇÃO", "528884 DUCHA HIGIENICA CROMADA FICTICIA 84818019 041 5922 UN 9 130,06 1.170,54", "FIM DOS PRODUTOS"]);
});

// Formatos de DANFE vistos em fornecedores reais, reescritos com dados fictícios.
const DANFE_DESCONTO = `Recebemos de FERRAGENS FICTICIAS LTDA SE os produtos e/ou serviços constantes da Nota Fiscal Eletrônica indicada ao lado.
Nº 000.000.777
Série 001
CNPJ / CPF
11.222.333/0001-81
CONSTRUTORA PARCERIA PROJETOS E CONSTRUCOES LTDA 04.602.232/0001-70 06/11/2026
BASE DE CÁLCULO DO ICMS VALOR DO ICMS VALOR DO ICMS SUBST. VALOR TOTAL DOS PRODUTOS
0,00 0,00 0,00 0,00 2.475,98
CÓDIGO VALOR VALOR VALOR BASE DE VALOR VALOR ALÍQ. %
DESCRIÇÃO DO PRODUTO / SERVIÇO NCM/SH CST CFOP UNID. QTDE.
PRODUTO UNITÁRIO DESCONTO LÍQUIDO CÁLC. ICMS ICMS IPI ICMS IPI
011007 TUBO ELETRODUTO FICTICIO 1 1/4 39172300 060 5405 UN 20,00 27,71 16,56 537,64 0,00 0,00 0,00 0,00 0,00
007424 LUVA ELETRODUTO FICTICIA 39174090 060 5405 UN 20,00 2,17 1,30 42,10 0,00 0,00 0,00 0,00 0,00
011028 CONDUL FICTICIO 12X12 85381000 000 5102 UN 14,00 12,37 5,17 168,01 168,01 34,44 0,00 20,50 0,00
008986 ARGAMASSA FICTICIA 20KG 38245000 060 5405 PC 60,00 28,42 50,95 1.654,25 0,00 0,00 0,00 0,00 0,00
DADOS ADICIONAIS`;

test('regressão: DANFE com coluna de desconto (unitário, desconto, total líquido) e total de produtos antes do desconto era recusada', () => {
  const r = lerNotaTexto(DANFE_DESCONTO);
  assert.deepEqual(r.motivos, []);
  assert.deepEqual(r.itens.map((i) => i.valor_total), [537.64, 42.1, 168.01, 1654.25], "total líquido (depois do desconto)");
  assert.equal(r.nota.valor_produtos, 2475.98);
  assert.equal(r.nota.numero, "000000777", 'número vem de "Nº 000.000.777"');
  assert.equal(r.nota.emitente_nome, "FERRAGENS FICTICIAS LTDA", 'sem "SE os produtos…" do canhoto');
});

const DANFE_CODIGO_LONGO = `RECEBEMOS DE SIDERURGICA FICTICIA S/A NF-e
DATA DE RECEBIMENTO IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR N. 000652129
SÉRIE 1
1 - SAÍDA CHAVE DE ACESSO
CNPJ
11.222.333/0001-81 06/11/2026 DATA DA EMISSÃO
V. IMP. IMPORTAÇÃO V. FCP UF DEST. VALOR DO PIS V. TOTAL PRODUTOS
12.510,81 2.502,15 0,00 0,00 193,83 1.748,33
CÓDIGO PRODUTO DESCRIÇÃO DO PRODUTO / SERVIÇO NCM/SH O/CST CFOP UN QUANT
000000000110006821 VERG FICTICIO 12,5mm DOB12m 72142000 5/20 5102 BR 25,0000 67,9332 1.698,33 0,00 1.072,50 203,77 19,00
BC Reduzida cfe Item 15 Anexo II, Art. 39
000000000119002691 MALHA FICTICIA 2x3m 73142000 5/00 5102 PC 5,0000 10,00 50,00 0,00 50,00 9,50 19,00
FIM DOS PRODUTOS`;

test('regressão: código de produto com 19 caracteres, CST "5/20", desconto 0,00 depois do total e rótulo "V. TOTAL PRODUTOS"; "Nº" escrito "N."', () => {
  const r = lerNotaTexto(DANFE_CODIGO_LONGO);
  assert.deepEqual(r.motivos, []);
  assert.deepEqual(r.itens.map((i) => [i.codigo.length, i.valor_total]), [[18, 1698.33], [18, 50]], "o 0,00 após o total não vira total");
  assert.equal(r.nota.valor_produtos, 1748.33);
  assert.equal(r.nota.numero, "000652129");
  assert.equal(r.nota.emitente_nome, "SIDERURGICA FICTICIA S/A", 'nome do canhoto; nunca "1 - SAÍDA CHAVE DE ACESSO"');
});

const DANFE_DESCRICAO_ENTRE_LINHAS = `RECEBEMOS DE LOJA FICTICIA EPP BA os Produtos / Serviços constantes da Nota
N°000011152
CNPJ
11.222.333/0001-81 DATA DA EMISSÃO 06/11/2026
VALOR TOTAL DOS PRODUTOS
181,65 37,24 0,00 0,00 61,80
CÓD. PROD. DESCRIÇÃO DOS PRODUTOS / SERVIÇOS NCM/SH CST CFOP UNID. QUANTIDADE VALOR UNITÁRIO VALOR TOTAL
PROTETOR AUDITIVO FICTICIO
600.00059 40159000 020 5102 UN 20,0000 1,1400 22,80 13,41 2,75 0,00 20,50 0,00
CORDAO 12DB
600.30972 RESPIRADOR FICTICIO PFF2 63079010 020 5102 UN 20,0000 1,9500 39,00 16,47 3,38 0,00 20,50 0,00
CÁLCULO DO ISSQN`;

test('regressão: item sem descrição na linha do código (nome impresso na linha de cima e de baixo) era descartado', () => {
  const r = lerNotaTexto(DANFE_DESCRICAO_ENTRE_LINHAS);
  assert.deepEqual(r.motivos, []);
  assert.equal(r.itens[0].descricao, "PROTETOR AUDITIVO FICTICIO CORDAO 12DB");
  assert.equal(r.itens[1].descricao, "RESPIRADOR FICTICIO PFF2");
  assert.equal(r.nota.emitente_nome, "LOJA FICTICIA EPP", 'sem a UF e o "os Produtos…" do canhoto');
});
