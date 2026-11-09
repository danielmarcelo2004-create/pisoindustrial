// Testes da identificação de notas em PDF (com camada de texto). Uso: node --test tests/notas-pdf.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extrairTextoPdf } from "../src/lib/pdf-texto.ts";
import { classificarNota as classificarComCnpj, lerNfseTexto } from "../src/lib/notas-contabeis.ts";

const EMPRESA = "04.602.232/0001-70";
const classificarNota = (d: Parameters<typeof classificarComCnpj>[0]) => classificarComCnpj(d, EMPRESA);


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

test("boletim de medição emitido pela própria empresa: categoria medição, com valor total e líquido", async () => {
  const { dados, classificacao } = await identificar("nfse-pdf-tabela-emitida-pela-empresa.pdf");
  assert.ok(dados);
  assert.equal(dados.prestadorDocumento, "04.602.232/0001-70");
  assert.equal(dados.medicao, true);
  assert.equal(dados.valor, 224599);
  assert.equal(dados.valorLiquido, 208652.47);
  assert.equal(classificacao?.categoria, "medicao_emitida");
});

test("nota tomada pela empresa em layout tabular: ISS retido e valor vêm da linha de valores", async () => {
  const { dados, classificacao } = await identificar("nfse-pdf-tabela-tomada-pela-empresa.pdf");
  assert.ok(dados);
  assert.equal(dados.prestadorDocumento, "11.222.333/0001-81");
  assert.equal(dados.tomadorDocumento, "04.602.232/0001-70");
  assert.equal(dados.prestadorNome, "EMPRESA PRESTADORA EXEMPLO LTDA");
  assert.equal(dados.valor, 224599);
  assert.equal(dados.retencoes.iss, 3930.48);
  assert.equal(dados.retencoes.inss, 8647.06);
  assert.equal(dados.dataEmissao, "2026-10-08");
  assert.equal(classificacao?.categoria, "tomado_pj_retencao");
});

test("nota cujo tomador é outra empresa não entra na lista", async () => {
  const texto = (await extrairTextoPdf(pdf("nfse-pdf-tabela-tomada-pela-empresa.pdf"))).replace(
    "04.602.232/0001-70",
    "99.888.777/0001-66",
  );
  const c = classificarNota(lerNfseTexto(texto)!);
  assert.equal(c.categoria, null);
  assert.match(c.motivo ?? "", /não é a tomadora/);
});

test("DANFSe de MEI com serviço de equipamentos eletrônicos: fica de fora, mesmo citando veículos no código de tributação", async () => {
  const { dados, classificacao } = await identificar("danfse-mei-eletronicos.pdf");
  assert.ok(dados);
  assert.equal(dados.mei, true);
  assert.equal(dados.numero, "20");
  assert.equal(dados.valor, 930);
  assert.equal(dados.prestadorDocumento, "53.953.945/0001-94");
  assert.equal(dados.tomadorDocumento, "04.602.232/0001-70");
  assert.deepEqual(dados.servicos, ["Prestação de serviço de manutenção em equipamentos eletrônicos."]);
  assert.equal(classificacao?.categoria, null);
  assert.match(classificacao?.motivo ?? "", /fora da lista/);
});
