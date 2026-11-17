// Leitura de comprovantes do Banco do Brasil (texto do OCR, com nomes e documentos trocados por fictícios)
// e casamento automático com os pagamentos em aberto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chaveComprovante, lerComprovante, semelhancaNome, sugerirCasamentos, type Aberto } from "../src/lib/comprovantes-banco.ts";

const ocr: Record<string, string> = JSON.parse(readFileSync(new URL("./fixtures/comprovantes-bb.json", import.meta.url), "utf8"));
const ler = (k: string) => lerComprovante(ocr[k]);

test("boletos: valor cobrado, data do pagamento, beneficiário, CNPJ e autenticação", () => {
  const b = ler("bol-1");
  assert.equal(b.tipo, "boleto");
  assert.equal(b.valor, 444.56);
  assert.equal(b.data, "2026-11-13");
  assert.equal(b.beneficiario, "ALFA MATERIAIS DE CONSTRUCAO LTDA");
  assert.equal(b.cnpj, "11222333000181");
  assert.equal(b.autenticacao, "46AEBFAA2D835480");
  assert.match(b.linhaDigitavel ?? "", /^\d{47}$/);
  assert.deepEqual([ler("bol-2").valor, ler("bol-3").valor], [940.44, 5636.18]);
});

test("PIX: valor sem a tarifa, data, favorecido, CPF mascarado e chave", () => {
  const p = ler("pix-05");
  assert.equal(p.tipo, "pix");
  assert.equal(p.valor, 315);
  assert.equal(p.tarifa, 3.11);
  assert.equal(p.data, "2026-11-13");
  assert.equal(p.beneficiario, "Mario P Souza Lima");
  assert.equal(p.cpfMeio, "111444");
  assert.equal(p.chavePix, "11144477735");
  assert.equal(p.cnpj, null, "o CNPJ do pagador (a própria empresa) não conta");
  const valores = ["pix-04", "pix-05", "pix-06", "pix-07", "pix-08", "pix-09", "pix-10", "pix-11"].map((k) => ler(k).valor);
  assert.deepEqual(valores, [3000, 315, 654.41, 7669, 7975, 700, 1000, 500]);
});

test("PIX por QR Code: CNPJ abreviado do recebedor; PIX com descrição", () => {
  assert.equal(ler("pix-06").cnpj, "00360305000104");
  assert.equal(ler("pix-11").descricao, "Fundo Fixo - UPB");
  assert.equal(ler("pix-11").cpfMeio, "366271", "o OCR troca o ponto por vírgula no CPF mascarado");
});

test("comprovante repetido (mesma autenticação em outro arquivo) é reconhecido", () => {
  assert.equal(chaveComprovante(ler("pix-01")), chaveComprovante(ler("bol-1")));
  assert.notEqual(chaveComprovante(ler("bol-1")), chaveComprovante(ler("bol-2")));
  const chaves = Object.keys(ocr).map((k) => chaveComprovante(ler(k)));
  assert.equal(new Set(chaves).size, 11, "14 páginas, 11 comprovantes diferentes");
});

test("página que não é comprovante não inventa valor", () => {
  const c = lerComprovante("Relatório de saldos\nConta corrente 13.970-X\nSaldo disponível");
  assert.equal(c.tipo, "outro");
  assert.equal(c.valor, null);
});

test("semelhança de nomes aceita abreviações e ignora LTDA/ME", () => {
  assert.ok(semelhancaNome("Rafael D F Costa", "Rafael Dias Ferreira Costa") >= 0.75);
  assert.ok(semelhancaNome("ALFA MATERIAIS DE CONSTRUCAO LTDA", "Alfa Materiais de Construção") >= 0.9);
  assert.equal(semelhancaNome("Mario P Souza Lima", "Construtora Delta"), 0);
  assert.equal(semelhancaNome("A B", "Ana Beatriz"), 0, "só iniciais não identificam");
});

const aberto = (n: number, favorecido: string, valor: number, extra: Partial<Aberto> = {}): Aberto => ({
  chave: `pag:${n}`, tipo: "pagamento", pagamentoId: String(n), numero: n, rotulo: `nº ${n}`, favorecido, valor, vencimento: "2026-11-13", ...extra,
});

test("casamento: valor + CNPJ/CPF/chave/nome dão confiança alta; cada pagamento recebe um comprovante só", () => {
  const comps = ["bol-1", "bol-2", "pix-04", "pix-05", "pix-07", "pix-08"].map(ler);
  const abertos = [
    aberto(1, "Alfa Materiais", 444.56, { cpfCnpj: "11.222.333/0001-81" }),
    aberto(2, "Beta EPI", 940.44),
    aberto(3, "Delta Engenharia Ltda", 3000),
    aberto(4, "Mario Pereira Souza Lima", 315, { cpfCnpj: "205.111.444-09" }),
    aberto(5, "Paulo Cesar Rocha", 7669, { chavePix: "paulorocha@email.com" }),
    aberto(6, "Rafael Dias Ferreira Costa", 7975),
  ];
  const s = sugerirCasamentos(comps, abertos);
  assert.deepEqual(s.map((x) => x.chave), ["pag:1", "pag:2", "pag:3", "pag:4", "pag:5", "pag:6"]);
  assert.equal(s[0].confianca, "alta");
  assert.match(s[0].motivo, /CNPJ/);
  assert.match(s[3].motivo, /CPF/);
  assert.match(s[4].motivo, /chave PIX/);
  assert.equal(s[1].confianca, "alta", "Beta EPI: valor e nome");
});

test("casamento: só o valor confere → média; dois pagamentos com o mesmo valor e nada que diferencie → ambígua", () => {
  const unico = sugerirCasamentos([ler("pix-09")], [aberto(1, "Fornecedor X", 700)]);
  assert.equal(unico[0].chave, "pag:1");
  assert.equal(unico[0].confianca, "media");
  const dois = sugerirCasamentos([ler("pix-09")], [aberto(1, "Fornecedor X", 700), aberto(2, "Fornecedor Y", 700)]);
  assert.equal(dois[0].chave, null);
  assert.equal(dois[0].confianca, "ambigua");
  assert.deepEqual(dois[0].alternativas.sort(), ["pag:1", "pag:2"]);
  // O nome desempata
  const comNome = sugerirCasamentos([ler("pix-09")], [aberto(1, "Fornecedor X", 700), aberto(2, "Lucia Mendes", 700)]);
  assert.equal(comNome[0].chave, "pag:2");
});

test("casamento: favorecido identificado mas valor diferente (juros) → sugere com aviso; valor sem pagamento → nenhum", () => {
  const s = sugerirCasamentos([ler("pix-10"), ler("pix-06")], [aberto(1, "Bruno Reis Alves", 980, { cpfCnpj: "988.842.057-00", chavePix: "98784205766" })]);
  assert.equal(s[0].chave, "pag:1");
  assert.equal(s[0].valorDiferente, true);
  assert.equal(s[0].confianca, "baixa");
  assert.equal(s[1].chave, null);
  assert.equal(s[1].confianca, "nenhuma");
});

test("casamento: parcela em aberto também é candidata; o mesmo pagamento não recebe dois comprovantes", () => {
  const parc: Aberto = { ...aberto(7, "Gama Financiamentos", 5636.18), chave: "parc:77", tipo: "parcela", parcelaId: "77" };
  const s = sugerirCasamentos([ler("bol-3"), ler("pix-03")], [parc]);
  assert.equal(s[0].chave, "parc:77");
  assert.equal(s[1].chave, null, "a cópia da mesma página não leva o mesmo pagamento");
});

test("casamento: parcelas de mesmo valor e mesmo favorecido são desempatadas pelo vencimento do boleto", () => {
  assert.equal(ler("bol-3").vencimento, "2026-11-13");
  const p1: Aberto = { ...aberto(8, "Gama Financiamentos", 5636.18), chave: "parc:1", tipo: "parcela", parcelaId: "1", vencimento: "2026-11-13" };
  const p2: Aberto = { ...aberto(8, "Gama Financiamentos", 5636.18), chave: "parc:2", tipo: "parcela", parcelaId: "2", vencimento: "2026-12-13" };
  const s = sugerirCasamentos([ler("bol-3")], [p2, p1]);
  assert.equal(s[0].chave, "parc:1");
});
