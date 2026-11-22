// Leitor de extrato OFX (versões 1.x em SGML, com ou sem tags de fechamento, e 2.x em XML).
// Testado com os formatos do Banco do Brasil e da Caixa (que usa MEMO num arquivo e NAME em outro).

export type LinhaOfx = { data: string; valor: number; tipo: string; descricao: string; fitid: string; documento: string };
export type ExtratoOfx = {
  banco: string;
  agencia: string;
  conta: string;
  inicio: string | null;
  fim: string | null;
  saldo: number | null;
  saldoEm: string | null;
  linhas: LinhaOfx[];
};

/** Decodifica o arquivo respeitando o cabeçalho (os bancos brasileiros usam Windows-1252). */
export function decodificarOfx(bytes: Uint8Array): string {
  const cabecalho = new TextDecoder("latin1").decode(bytes.slice(0, 600));
  const utf8 = /ENCODING:\s*UTF-?8|encoding="utf-8"/i.test(cabecalho) && !/CHARSET:\s*(1252|ISO-8859-1)/i.test(cabecalho);
  return new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(bytes);
}

const campo = (bloco: string, tag: string) => {
  const m = bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  return m ? m[1].trim() : "";
};
const dataOfx = (v: string) => {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(new Date(iso + "T12:00:00Z").getTime()) ? null : iso;
};
const numero = (v: string) => {
  const t = v.replace(/\s/g, "");
  if (!t) return NaN;
  // Alguns bancos usam vírgula decimal
  const n = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t);
  return Math.round(n * 100) / 100;
};
const limpar = (v: string) =>
  v
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

export function lerOfx(texto: string): ExtratoOfx {
  if (!/<OFX>/i.test(texto)) throw new Error("O arquivo não é um extrato OFX.");
  const contaBloco = texto.match(/<BANKACCTFROM>([\s\S]*?)(<\/BANKACCTFROM>|<BANKTRANLIST>)/i)?.[1] ?? "";
  const banco = campo(contaBloco, "BANKID") || campo(texto, "FID");
  const agencia = campo(contaBloco, "BRANCHID");
  const conta = campo(contaBloco, "ACCTID");
  if (!conta) throw new Error("O extrato não informa a conta bancária.");
  if (/<CCACCTFROM>/i.test(texto) && !contaBloco) throw new Error("Este é um extrato de cartão de crédito; importe o extrato da conta corrente.");

  const linhas: LinhaOfx[] = [];
  const blocos = texto.split(/<STMTTRN>/i).slice(1);
  for (const b0 of blocos) {
    const b = b0.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0];
    const data = dataOfx(campo(b, "DTPOSTED"));
    const valor = numero(campo(b, "TRNAMT"));
    if (!data || !Number.isFinite(valor) || valor === 0) continue;
    const memo = limpar(campo(b, "MEMO"));
    const nome = limpar(campo(b, "NAME"));
    linhas.push({
      data,
      valor,
      tipo: campo(b, "TRNTYPE").toUpperCase(),
      descricao: memo && nome && !memo.includes(nome) ? `${nome} — ${memo}` : memo || nome,
      fitid: campo(b, "FITID"),
      documento: campo(b, "CHECKNUM") || campo(b, "REFNUM"),
    });
  }
  const saldoBloco = texto.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<MKTGINFO>|<\/STMTRS>)/i)?.[1] ?? "";
  const saldo = numero(campo(saldoBloco, "BALAMT"));
  return {
    banco,
    agencia,
    conta,
    inicio: dataOfx(campo(texto, "DTSTART")),
    fim: dataOfx(campo(texto, "DTEND")),
    saldo: Number.isFinite(saldo) ? saldo : null,
    saldoEm: dataOfx(campo(saldoBloco, "DTASOF")),
    linhas,
  };
}

export const NOME_BANCO: Record<string, string> = { "001": "Banco do Brasil", "104": "Caixa", "237": "Bradesco", "341": "Itaú", "033": "Santander", "077": "Inter", "260": "Nubank", "748": "Sicredi", "756": "Sicoob" };
export const normalizarBanco = (b: string) => b.replace(/\D/g, "").padStart(3, "0").slice(-3);
export const normalizarConta = (c: string) => c.toUpperCase().replace(/[^0-9X]/g, "").replace(/^0+/, "");
