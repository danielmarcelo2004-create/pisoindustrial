// Testes da leitura de XML de NF-e. Uso: node --test tests/nfe.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lerNFe, normalizarDescricao } from "../src/lib/nfe.ts";

test("lê NF-e com protocolo (nfeProc)", () => {
  const r = lerNFe(readFileSync(new URL("./exemplos/nfe-exemplo-concreto.xml", import.meta.url), "utf8"));
  assert.ok(r);
  assert.equal(r.nota.chave, "29261112345678000190550010000045671000045678");
  assert.equal(r.nota.numero, "4567");
  assert.equal(r.nota.data_emissao, "2026-10-28");
  assert.equal(r.nota.emitente_cnpj, "12345678000190");
  assert.equal(r.nota.emitente_uf, "BA");
  assert.equal(r.nota.valor_frete, 350);
  assert.equal(r.nota.valor_total, 20463.4);
  assert.equal(r.itens.length, 3);
  assert.deepEqual(
    { q: r.itens[0].quantidade, vu: r.itens[0].valor_unitario, un: r.itens[0].unidade, t: r.itens[0].valor_total },
    { q: 32, vu: 592.5, un: "M3", t: 18960 },
  );
  assert.equal(r.itens[2].quantidade, 20.5);
});

test("lê NF-e sem protocolo, com um único item e chave no Id", () => {
  const xml = `<NFe><infNFe Id="NFe29261112345678000190550010000000011000000011"><ide><nNF>1</nNF><serie>2</serie><dEmi>2026-01-05</dEmi></ide>
    <emit><CNPJ>01234567000100</CNPJ><xNome>Aço &amp; Cia</xNome><enderEmit><UF>SE</UF></enderEmit></emit>
    <det nItem="1"><prod><cProd>001</cProd><xProd>Tela soldada Q-196</xProd><uCom>pc</uCom><qCom>10</qCom><vUnCom>132.5</vUnCom><vProd>1325.00</vProd></prod></det>
    <total><ICMSTot><vNF>1325.00</vNF></ICMSTot></total></infNFe></NFe>`;
  const r = lerNFe(xml);
  assert.ok(r);
  assert.equal(r.nota.chave, "29261112345678000190550010000000011000000011");
  assert.equal(r.nota.data_emissao, "2026-01-05");
  assert.equal(r.nota.emitente_cnpj, "01234567000100");
  assert.equal(r.itens.length, 1);
  assert.equal(r.itens[0].codigo, "001");
  assert.equal(r.itens[0].unidade, "PC");
});

test("rejeita XML que não é NF-e", () => {
  assert.equal(lerNFe("<html><body>oi</body></html>"), null);
  assert.equal(lerNFe("isto não é xml <<<"), null);
});

test("não resolve entidades externas (XXE)", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>
    <NFe><infNFe><ide><dEmi>2026-01-01</dEmi></ide><emit><xNome>&e;</xNome></emit>
    <det nItem="1"><prod><xProd>Item</xProd><qCom>1</qCom><vUnCom>1</vUnCom><vProd>1</vProd></prod></det></infNFe></NFe>`;
  const r = lerNFe(xml);
  assert.ok(!r || !r.nota.emitente_nome.includes("root:"));
});

test("normaliza descrições para comparação", () => {
  assert.equal(normalizarDescricao("  CIMENTO CP-II  50KG, Votorantim "), "cimento cp ii 50kg votorantim");
  assert.equal(normalizarDescricao("Aço CA-50 Ø 10,0mm"), "aco ca 50 10.0mm");
});

test("OCR de DANFE: grade da tabela, CST ilegível, quantidade com letra colada e unidade ausente", async () => {
  const { lerNotaTexto } = await import("../src/lib/ocr/nota-fiscal.ts");
  const texto = [
    "CONSTRUTORA PARCERIA PROJETOS E CONSTRUCOES LTDA 04.602.232/0001-70 25/09/2026 10:45",
    "NOME/RAZÃO SOCIAL CNPJ/CPF DATA DA EMISSÃO",
    "ITABLOCK LTDA 57.087.364/0001-78 25/09/2026",
    "Nº: 000.000.247",
    "COD. DESCRIÇÃO DO PRODUTO/SERVIÇO NOM cst | croP | uno. QUANT. |VALORUNITARIO [vaLorTOTAL",
    "16555 PISO INTERTRAVADOS DE CONCRETO 68101100 | ooo | 5101 40,000d 55,00000 2.200,00 2.200,00 418,00 | eso] 19,00 | oo 693.66",
    "RETANGULAR 10X20X06 35MPA",
    "16766 PISO INTERTRAVADOS DE CONCRETO 68101100 | oo | 5101 100,000d 65,00000 6.500,00 6.500,00 1235,00 | eso] 19,00 | oo 2049.45",
    "VALOR TOTAL DOS PRODUTOS 8.700,00",
    "VALOR TOTAL DA NOTA 8.700,00",
  ].join("\n");
  const r = lerNotaTexto(texto);
  assert.equal(r.itens.length, 2);
  assert.deepEqual(r.itens.map((i) => [i.codigo, i.quantidade, i.valor_unitario, i.valor_total]), [
    ["16555", 40, 55, 2200],
    ["16766", 100, 65, 6500],
  ]);
  assert.equal(r.itens[0].unidade, null);
  assert.ok(!r.motivos.includes("nenhum item lido"));
});
