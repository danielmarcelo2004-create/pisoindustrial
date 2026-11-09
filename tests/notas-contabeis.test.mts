// Testes da identificação de notas para a contabilidade. Uso: node --test tests/notas-contabeis.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classificarNota as classificarComCnpj, lerNfseTexto, lerNfseXml, type DadosNota } from "../src/lib/notas-contabeis.ts";

const EMPRESA = "04.602.232/0001-70";
const classificarNota = (d: DadosNota) => classificarComCnpj(d, EMPRESA);

const exemplo = (nome: string) => readFileSync(new URL(`./exemplos/${nome}`, import.meta.url), "utf8");
const base: DadosNota = {
  ehNfse: true,
  prestadorDocumento: "11222333000181",
  tomadorDocumento: null,
  prestadorNome: "Teste",
  numero: "1",
  dataEmissao: "2026-11-01",
  valor: 100,
  mei: false,
  servicos: ["Instalação elétrica"],
  retencoes: { inss: 0, irrf: 0, csrf: 0, iss: 0 },
};

test("NFS-e de PJ com retenção de INSS é classificada como tomado_pj_retencao", () => {
  const d = lerNfseXml(exemplo("nfse-pj-retencao.xml"));
  assert.ok(d);
  assert.equal(d.prestadorDocumento, "11222333000181");
  assert.equal(d.retencoes.inss, 550);
  assert.equal(d.retencoes.csrf, 232.5); // CSLL + PIS + COFINS
  assert.equal(d.retencoes.iss, 250);
  assert.equal(d.dataEmissao, "2026-11-03");
  assert.equal(classificarNota(d).categoria, "tomado_pj_retencao");
});

test("PJ sem nenhuma retenção não entra na lista", () => {
  const c = classificarNota({ ...base, prestadorDocumento: "11222333000181" });
  assert.equal(c.categoria, null);
  assert.match(c.motivo ?? "", /sem retenção/);
});

test("NFS-e de pessoa física é classificada como tomado_pf, mesmo sem retenção", () => {
  const d = lerNfseXml(exemplo("nfse-pf-avulsa.xml"));
  assert.ok(d);
  assert.equal(d.prestadorDocumento, "52998224725");
  assert.equal(classificarNota(d).categoria, "tomado_pf");
});

test("MEI com serviços permitidos (hidráulica) é mei_servicos_especificos", () => {
  const d = lerNfseXml(exemplo("nfse-mei-hidraulica.xml"));
  assert.ok(d);
  assert.equal(d.mei, true);
  assert.equal(classificarNota(d).categoria, "mei_servicos_especificos");
});

test("MEI que presta também outro serviço não entra na categoria MEI", () => {
  const d = lerNfseXml(exemplo("nfse-mei-outros-servicos.xml"));
  assert.ok(d);
  const c = classificarNota(d);
  assert.equal(c.categoria, null);
  assert.match(c.motivo ?? "", /fora da lista/);
});

test("NFS-e no padrão nacional (com ISS retido e INSS) é lida e classificada", () => {
  const d = lerNfseXml(exemplo("nfse-nacional-pj.xml"));
  assert.ok(d);
  assert.equal(d.prestadorDocumento, "98765432000155");
  assert.equal(d.mei, false);
  assert.equal(d.retencoes.inss, 352);
  assert.equal(d.retencoes.iss, 160);
  assert.equal(d.numero, "5531");
  assert.equal(classificarNota(d).categoria, "tomado_pj_retencao");
});

test("NF-e de produto (não é serviço) não é lida como NFS-e", () => {
  assert.equal(lerNfseXml(exemplo("nfe-exemplo-concreto.xml")), null);
});

test("MEI: a lista de serviços só aceita os tipos permitidos", () => {
  const meiOk = (s: string) => classificarNota({ ...base, prestadorDocumento: "45123456000190", mei: true, servicos: [s] }).categoria;
  assert.equal(meiOk("Pintura de fachada"), "mei_servicos_especificos");
  assert.equal(meiOk("Alvenaria de vedação"), "mei_servicos_especificos");
  assert.equal(meiOk("Carpintaria em forma"), "mei_servicos_especificos");
  assert.equal(meiOk("Manutenção de veículo da frota"), "mei_servicos_especificos");
  assert.equal(meiOk("Desenvolvimento de software"), null);
});

test("NFS-e em texto de PDF é identificada pelo prestador e pelas retenções", () => {
  const texto = [
    "NFS-e Nº 3021 EMISSÃO 07/11/2026",
    "PRESTADOR",
    "Eletro Serviços LTDA CNPJ 22.333.444/0001-55",
    "DISCRIMINAÇÃO DOS SERVIÇOS",
    "Instalação de tomadas e pontos de luz",
    "VALOR TOTAL DOS SERVIÇOS R$ 2.000,00",
    "INSS R$ 220,00",
    "ISS RETIDO R$ 100,00",
  ].join("\n");
  const d = lerNfseTexto(texto);
  assert.ok(d);
  assert.equal(d.prestadorDocumento, "22.333.444/0001-55");
  assert.equal(d.retencoes.inss, 220);
  assert.equal(d.retencoes.iss, 100);
  assert.equal(d.dataEmissao, "2026-11-07");
  assert.equal(classificarNota(d).categoria, "tomado_pj_retencao");
});

test("texto que não é NFS-e não é classificado", () => {
  assert.equal(lerNfseTexto("DANFE NF-e modelo 55 Valor total da nota 100,00"), null);
});
