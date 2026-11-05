// Testes da leitura de nota fiscal a partir do texto do OCR. Uso: node --test tests/nota/
import { test } from "node:test";
import assert from "node:assert/strict";
import { lerNotaTexto } from "../../src/lib/ocr/nota-fiscal.ts";

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
