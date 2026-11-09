// Testes do cálculo de impostos de notas de medição. Uso: node --test tests/impostos-medicao.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularImpostosMedicao } from "../src/lib/impostos-medicao.ts";

test("nota de medição real: retido = total − líquido, devido = 14% − retido, com percentuais", () => {
  const c = calcularImpostosMedicao(224599, 208652.47);
  assert.ok(c);
  assert.equal(c.retido, 15946.53);
  assert.equal(c.devido, 15497.33); // 14% de 224.599,00 = 31.443,86; − 15.946,53
  assert.equal(c.percRetido, 7.1);
  assert.equal(c.percDevido, 6.9);
});

test("nota sem retenção: todo o imposto de 14% é devido", () => {
  const c = calcularImpostosMedicao(1000, 1000);
  assert.ok(c);
  assert.equal(c.retido, 0);
  assert.equal(c.devido, 140);
  assert.equal(c.percDevido, 14);
});

test("retenção acima de 14%: o devido sai negativo (excedente)", () => {
  const c = calcularImpostosMedicao(1000, 800);
  assert.ok(c);
  assert.equal(c.retido, 200);
  assert.equal(c.devido, -60);
  assert.equal(c.percDevido, -6);
});

test("sem valor líquido ou com valores inválidos: não calcula", () => {
  assert.equal(calcularImpostosMedicao(1000, null), null);
  assert.equal(calcularImpostosMedicao(null, 900), null);
  assert.equal(calcularImpostosMedicao(0, 0), null);
  assert.equal(calcularImpostosMedicao(1000, 1200), null);
});
