// Testes da identificação de notas em PDF (com camada de texto). Uso: node --test tests/notas-pdf.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extrairTextoPdf } from "../src/lib/pdf-texto.ts";
import { classificarNota, lerNfseTexto } from "../src/lib/notas-contabeis.ts";

const pdf = (nome: string) => readFileSync(new URL(`./exemplos/${nome}`, import.meta.url));

async function identificar(nome: string) {
  const texto = await extrairTextoPdf(pdf(nome));
  const dados = lerNfseTexto(texto);
  return { texto, dados, classificacao: dados ? classificarNota(dados) : null };
}

test("o texto do PDF é extraído com as palavras-chave da nota", async () => {
  const { texto } = await identificar("nfse-pdf-pj-retencao.pdf");
  assert.match(texto, /DISCRIMINAÇÃO DOS SERVIÇOS/);
  assert.match(texto, /INSS R\$ 220,00/);
});

test("NFS-e de PJ com INSS e ISS retidos em PDF: tomado_pj_retencao", async () => {
  const { dados, classificacao } = await identificar("nfse-pdf-pj-retencao.pdf");
  assert.ok(dados, "não reconheceu como NFS-e");
  assert.equal(dados.prestadorDocumento, "22.333.444/0001-55");
  assert.equal(dados.prestadorNome, "Eletro Serviços LTDA");
  assert.equal(dados.numero, "3021");
  assert.equal(dados.dataEmissao, "2026-11-07");
  assert.equal(dados.valor, 2000);
  assert.equal(dados.retencoes.inss, 220);
  assert.equal(dados.retencoes.iss, 100);
  assert.equal(classificacao?.categoria, "tomado_pj_retencao");
});

test("nota avulsa de pessoa física em PDF: tomado_pf", async () => {
  const { dados, classificacao } = await identificar("nfse-pdf-pf.pdf");
  assert.ok(dados, "não reconheceu como nota de serviço");
  assert.equal(dados.prestadorDocumento, "529.982.247-25");
  assert.equal(dados.valor, 1200);
  assert.equal(classificacao?.categoria, "tomado_pf");
});

test("MEI com serviço de hidráulica em PDF: mei_servicos_especificos", async () => {
  const { dados, classificacao } = await identificar("nfse-pdf-mei-hidraulica.pdf");
  assert.ok(dados);
  assert.equal(dados.mei, true);
  assert.equal(dados.numero, "205");
  assert.deepEqual(dados.servicos, ["Reparo de vazamento na tubulação hidráulica do banheiro"]);
  assert.equal(classificacao?.categoria, "mei_servicos_especificos");
});

test("MEI com um serviço fora da lista em PDF: não entra", async () => {
  const { classificacao } = await identificar("nfse-pdf-mei-outros-servicos.pdf");
  assert.equal(classificacao?.categoria, null);
  assert.match(classificacao?.motivo ?? "", /fora da lista/);
});

test("DANFE de produto em PDF não é tratada como nota de serviço", async () => {
  const { dados } = await identificar("danfe-produto.pdf");
  assert.equal(dados, null);
});
