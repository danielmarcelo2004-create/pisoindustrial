// Leitura de comprovantes bancários (texto vindo do OCR ou da camada de texto do PDF) e
// casamento automático com os pagamentos em aberto. Sem dependências de navegador: testável no Node.
//
// Formatos conhecidos (Banco do Brasil): "Comprovante de pagamento de títulos" (boleto) e
// "Comprovante Pix" (transferência ou QR Code). Para outros bancos há padrões genéricos de reserva.

export const CNPJ_EMPRESA = "04602232000170";

export type TipoComprovante = "boleto" | "pix" | "outro";

export type Comprovante = {
  tipo: TipoComprovante;
  /** Valor efetivamente pago (boleto: valor cobrado; PIX: valor, sem a tarifa). */
  valor: number | null;
  tarifa: number | null;
  /** Data do pagamento (AAAA-MM-DD). */
  data: string | null;
  /** Vencimento impresso no comprovante de boleto (desempata parcelas de mesmo valor). */
  vencimento: string | null;
  beneficiario: string | null;
  /** CNPJ (14 dígitos) do beneficiário ou CPF mascarado ("***508135**" → só os 6 dígitos do meio). */
  cnpj: string | null;
  cpfMeio: string | null;
  chavePix: string | null;
  autenticacao: string | null;
  linhaDigitavel: string | null;
  descricao: string | null;
};

const numBR = (s: string) => Number(s.replace(/\s/g, "").replace(/\./g, "").replace(",", "."));
const dataISO = (s: string) => {
  const [d, m, a] = s.split("/");
  return `${a}-${m}-${d}`;
};
const soDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
/** Linhas do texto, sem espaços repetidos e sem linhas vazias (o OCR intercala linhas em branco). */
const linhasDe = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

/** Valor em reais logo após o rótulo: aceita "R$3.000,00", "R$ 3.000,00", "RS3.000,00" e "444,56". */
function valorApos(texto: string, rotulo: RegExp): number | null {
  const re = new RegExp(rotulo.source + String.raw`\s*:?\s*(?:R\s?[$S5]\s?)?(\d{1,3}(?:[.\s]?\d{3})*,\d{2})`, "i");
  const m = texto.match(re);
  return m ? numBR(m[1]) : null;
}

/** Texto da linha logo depois de um rótulo que fica sozinho na linha (ex.: "BENEFICIARIO:"). */
function linhaDepois(linhas: string[], rotulo: RegExp): string | null {
  const i = linhas.findIndex((l) => rotulo.test(l));
  return i >= 0 && linhas[i + 1] ? linhas[i + 1] : null;
}

export function lerComprovante(texto: string): Comprovante {
  const linhas = linhasDe(texto);
  const corrido = linhas.join("\n");
  const pix = /comprovante\s+pix|pago\s+para\s*:/i.test(corrido);
  const boleto = !pix && /pagamento\s+de\s+t[ií]tulos|valor\s+cobrado|linha\s+digit[aá]vel|benefici[aá]rio/i.test(corrido);
  const tipo: TipoComprovante = pix ? "pix" : boleto ? "boleto" : "outro";

  let valor: number | null = null;
  let tarifa: number | null = null;
  let data: string | null = null;
  let beneficiario: string | null = null;
  const ve = corrido.match(/DATA\s+DE\s+VENCIMENTO\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
  const vencimento = ve ? dataISO(ve[1]) : null;

  if (tipo === "pix") {
    // "VALOR:" sozinho (não "VALOR MÁXIMO", não a TARIFA)
    valor = valorApos(corrido, /(?:^|\n)\s*VALOR(?!\s*m[aá]ximo)/);
    tarifa = valorApos(corrido, /TARIFA/);
    const d = corrido.match(/(?:^|\n)\s*DATA\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    data = d ? dataISO(d[1]) : null;
    const p = corrido.match(/PAGO\s+PARA\s*:?\s*(.+)/i);
    beneficiario = p ? p[1].trim() : null;
  } else {
    valor =
      valorApos(corrido, /VALOR\s+COBRADO/) ??
      valorApos(corrido, /VALOR\s+PAGO/) ??
      valorApos(corrido, /VALOR\s+TOTAL/) ??
      valorApos(corrido, /VALOR\s+DO\s+DOCUMENTO/);
    const d = corrido.match(/DATA\s+(?:DO|DE)\s+PAGAMENTO\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    data = d ? dataISO(d[1]) : null;
    const b = corrido.match(/BENEFICI[AÁ]RIO\s*(?:FINAL)?\s*:\s*(\S.+)/i);
    beneficiario = b && !/^(NOME|CNPJ|CPF)/i.test(b[1]) ? b[1].trim() : linhaDepois(linhas, /^BENEFICI[AÁ]RIO\s*:?$/i);
  }
  if (!data) {
    // Data do cabeçalho do comprovante (primeira data do texto)
    const d = corrido.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
    data = d ? dataISO(d[1]) : null;
  }

  // CNPJ do beneficiário: o primeiro CNPJ que não é o da empresa (pagador/devedor)
  const cnpjs = [...corrido.matchAll(/(?<![\d.])(\d{0,3}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2})\b/g)]
    .map((m) => soDigitos(m[1]).padStart(14, "0"))
    .filter((c) => c.length === 14 && c !== CNPJ_EMPRESA);
  const cnpj = cnpjs[0] ?? null;
  // CPF mascarado do PIX: "***.508.135-**" (o OCR às vezes troca o ponto por vírgula)
  const cpf = corrido.match(/CPF\s*:?\s*\*{2,3}[.,]?\s*(\d{3})[.,]\s*(\d{3})-?\*{0,2}/i);
  const cpfMeio = cpf ? cpf[1] + cpf[2] : null;

  const ch = corrido.match(/CHAVE\s+PIX\s*:?\s*(\S+)/i);
  const chavePix = ch ? ch[1].trim() : null;
  const au = corrido.match(/AUTENTICA[CÇ][AÃ]O(?:\s+SISBB)?\s*:?\s*([0-9A-F][0-9A-F. ]{8,}[0-9A-F])/i);
  const autenticacao = au ? au[1].replace(/[\s.]/g, "").toUpperCase() : null;
  const ld = corrido.replace(/[ .]/g, "").match(/\d{44,48}/);
  const linhaDigitavel = ld ? ld[0] : null;
  const de = corrido.match(/DESCRI[CÇ][AÃ]O\s*:\s*(.+)/i);
  const descricao = de ? de[1].trim() : null;

  return { tipo, valor, tarifa, data, vencimento, beneficiario, cnpj, cpfMeio, chavePix, autenticacao, linhaDigitavel, descricao };
}

/** Chave para reconhecer o mesmo comprovante repetido (no mesmo PDF ou em outro arquivo). */
export function chaveComprovante(c: Comprovante): string | null {
  if (c.autenticacao && c.autenticacao.length >= 10) return "aut:" + c.autenticacao;
  if (c.linhaDigitavel && c.valor !== null) return `ld:${c.linhaDigitavel}:${c.valor}`;
  if (c.valor !== null && c.data && c.beneficiario) return `vdb:${c.valor}:${c.data}:${normalizarNome(c.beneficiario)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Casamento com os pagamentos em aberto

export type Aberto = {
  /** Identificador único da opção: "pag:<id>" ou "parc:<id>". */
  chave: string;
  tipo: "pagamento" | "parcela";
  pagamentoId: string;
  parcelaId?: string;
  numero: number;
  rotulo: string;
  favorecido: string;
  valor: number;
  vencimento: string | null;
  cpfCnpj?: string | null;
  chavePix?: string | null;
  formaPagamento?: string | null;
};

export type Confianca = "alta" | "media" | "baixa" | "ambigua" | "nenhuma";

export type Sugestao = {
  chave: string | null;
  confianca: Confianca;
  motivo: string;
  /** Outros pagamentos com o mesmo valor (para o usuário escolher quando há dúvida). */
  alternativas: string[];
  valorDiferente: boolean;
};

const PALAVRAS_VAZIAS = new Set(["DE", "DA", "DO", "DOS", "DAS", "E", "LTDA", "ME", "EIRELI", "EIREL", "SA", "S", "A", "EPP", "CIA", "COMERCIO", "INDUSTRIA", "IMPORT"]);

export function normalizarNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Semelhança entre nomes: fração das palavras do menor nome encontradas no outro (aceita abreviações "C" = "CARLOS"). */
export function semelhancaNome(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const pa = normalizarNome(a).split(" ").filter((p) => p && !PALAVRAS_VAZIAS.has(p));
  const pb = normalizarNome(b).split(" ").filter((p) => p && !PALAVRAS_VAZIAS.has(p));
  if (!pa.length || !pb.length) return 0;
  const [menor, maior] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  const bate = (p: string) => maior.some((q) => q === p || (p.length === 1 && q.startsWith(p)) || (q.length === 1 && p.startsWith(q)) || (p.length >= 4 && q.length >= 4 && (q.startsWith(p) || p.startsWith(q))));
  const longas = menor.filter((p) => p.length > 1);
  if (!longas.some(bate)) return 0; // abreviações sozinhas não bastam
  return menor.filter(bate).length / menor.length;
}

function normalizarChave(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.trim().toLowerCase().replace(/\*/g, "@"); // o OCR costuma ler "@" como "*"
  if (t.includes("@")) return t;
  const d = soDigitos(t);
  return d.length >= 12 && d.startsWith("55") ? d.slice(2) : d;
}

function pontuar(c: Comprovante, a: Aberto) {
  let pontos = 0;
  const motivos: string[] = [];
  const valorIgual = c.valor !== null && Math.abs(c.valor - a.valor) < 0.005;
  if (valorIgual) {
    pontos += 40;
    motivos.push("valor");
  }
  const doc = soDigitos(a.cpfCnpj);
  if (c.cnpj && doc.length === 14 && doc === c.cnpj) {
    pontos += 50;
    motivos.push("CNPJ");
  } else if (c.cpfMeio && doc.length === 11 && doc.slice(3, 9) === c.cpfMeio) {
    pontos += 45;
    motivos.push("CPF");
  }
  const chaveA = normalizarChave(a.chavePix);
  const chaveC = normalizarChave(c.chavePix);
  if (chaveA && chaveC && chaveA === chaveC) {
    pontos += 45;
    motivos.push("chave PIX");
  }
  // Vencimento: o do boleto igual ao do pagamento/parcela, ou a data do pagamento próxima do vencimento
  if (a.vencimento && c.vencimento && a.vencimento === c.vencimento) pontos += 10;
  else if (a.vencimento && c.data && Math.abs(Date.parse(a.vencimento) - Date.parse(c.data)) <= 3 * 86400000) pontos += 3;
  const nome = semelhancaNome(c.beneficiario, a.favorecido);
  if (nome >= 0.6) {
    pontos += Math.round(30 * nome);
    motivos.push("nome");
  }
  return { pontos, motivos, valorIgual, identificou: motivos.some((m) => m !== "valor") };
}

/**
 * Sugere, para cada comprovante, o pagamento (ou parcela) em aberto correspondente.
 * Regra: o valor precisa bater, salvo quando CNPJ/CPF/chave PIX e nome identificam o favorecido
 * (aí a sugestão sai marcada como "valor diferente"). Cada pagamento recebe no máximo um comprovante.
 * Quando há mais de um pagamento com o mesmo valor e nada os diferencia, não sugere (ambígua).
 */
export function sugerirCasamentos(comprovantes: (Comprovante | null)[], abertos: Aberto[]): Sugestao[] {
  type Par = { i: number; a: Aberto; pontos: number; motivos: string[]; valorIgual: boolean };
  const pares: Par[] = [];
  comprovantes.forEach((c, i) => {
    if (!c) return;
    for (const a of abertos) {
      const p = pontuar(c, a);
      const aceitavel = p.valorIgual || (p.identificou && p.pontos >= 75);
      if (aceitavel) pares.push({ i, a, ...p });
    }
  });
  pares.sort((x, y) => y.pontos - x.pontos);

  const resultado: Sugestao[] = comprovantes.map(() => ({ chave: null, confianca: "nenhuma", motivo: "Nenhum pagamento em aberto com este valor.", alternativas: [], valorDiferente: false }));
  const usados = new Set<string>();
  const resolvidos = new Set<number>();
  for (const par of pares) {
    if (resolvidos.has(par.i) || usados.has(par.a.chave)) continue;
    const concorrentes = pares.filter((q) => q.i === par.i && !usados.has(q.a.chave) && q.a.chave !== par.a.chave);
    const empate = concorrentes.some((q) => q.pontos === par.pontos);
    const mesmoValor = pares.filter((q) => q.i === par.i && q.valorIgual).map((q) => q.a.chave);
    if (empate) {
      resultado[par.i] = {
        chave: null,
        confianca: "ambigua",
        motivo: `${concorrentes.filter((q) => q.pontos === par.pontos).length + 1} pagamentos com o mesmo valor e nada que os diferencie: escolha qual é.`,
        alternativas: mesmoValor,
        valorDiferente: false,
      };
      resolvidos.add(par.i);
      continue;
    }
    const identificou = par.motivos.some((m) => m !== "valor");
    resultado[par.i] = {
      chave: par.a.chave,
      confianca: !par.valorIgual ? "baixa" : identificou ? "alta" : concorrentes.length === 0 ? "media" : "baixa",
      motivo: !par.valorIgual
        ? `Favorecido identificado por ${par.motivos.join(" e ")}, mas o valor é diferente.`
        : identificou
          ? `Valor e ${par.motivos.filter((m) => m !== "valor").join(" e ")} conferem.`
          : "Só o valor confere (nenhum outro pagamento em aberto tem esse valor).",
      alternativas: mesmoValor.filter((k) => k !== par.a.chave),
      valorDiferente: !par.valorIgual,
    };
    usados.add(par.a.chave);
    resolvidos.add(par.i);
  }
  return resultado;
}
