import { type NextRequest } from "next/server";
import { dadosRelatorio, lerFiltros } from "@/lib/consultas/relatorios";
import { gerarExcelRelatorio, gerarPdfRelatorio, respostaPdf, respostaXlsx, type ColunaRel, type CorSituacao, type RelatorioTabela } from "@/lib/relatorio-tabela";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { getUsuario } from "@/lib/auth";
import { data as dataBR } from "@/lib/formato";

const resumoColunas = (titulo: string): ColunaRel[] => [
  { titulo, chave: "rotulo", largura: 30 },
  { titulo: "Qtd.", chave: "qtd", largura: 6, tipo: "numero" },
  { titulo: "Total (R$)", chave: "total", largura: 12, tipo: "moeda" },
  { titulo: "Pago (R$)", chave: "pago", largura: 12, tipo: "moeda" },
  { titulo: "Em aberto (R$)", chave: "aberto", largura: 12, tipo: "moeda" },
  { titulo: "Vencido (R$)", chave: "vencido", largura: 12, tipo: "moeda" },
];

function corDoStatus(status: string, vencido: boolean): CorSituacao {
  if (status === "pago") return "verde";
  if (status === "cancelado") return "cinza";
  if (vencido) return "vermelho";
  if (status === "rejeitado") return "vermelho";
  if (status === "aguardando_pagamento") return "azul";
  return "ambar";
}

/** Relatório de pagamentos: Excel organizado (abas) ou PDF para imprimir (formato=pdf), com os mesmos filtros da tela. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: c } = await supabase.auth.getClaims();
  if (!c?.claims?.sub) return new Response("Não autorizado", { status: 401 });
  const u = await getUsuario();
  const sp = request.nextUrl.searchParams;
  const f = lerFiltros((k) => sp.get(k));
  const r = await dadosRelatorio(f);

  const baseRotulo = { vencimento: "vencimento", pago_em: "data de pagamento", criacao: "data de cadastro", data_competencia: "competência" }[f.base];
  const periodo = `${dataBR(f.de)} a ${dataBR(f.ate)} (por ${baseRotulo})`;
  const nome = async (tabela: "obras" | "categorias" | "fornecedores", id?: string) =>
    id && id !== "sem" ? ((await supabase.from(tabela).select("nome").eq("id", id).maybeSingle()).data?.nome ?? null) : null;
  const [nObra, nCat, nForn] = await Promise.all([nome("obras", f.obra), nome("categorias", f.categoria), nome("fornecedores", f.fornecedor)]);
  const filtros: string[] = [`Período: ${periodo}`];
  if (nObra) filtros.push(`Centro de custo: ${nObra}`);
  if (nCat) filtros.push(`Categoria: ${nCat}`);
  if (f.categoria === "sem") filtros.push("Categoria: sem categoria");
  if (nForn) filtros.push(`Fornecedor: ${nForn}`);
  if (f.status) filtros.push(`Situação: ${f.status === "abertos" ? "em aberto" : (STATUS_PAGAMENTO[f.status as keyof typeof STATUS_PAGAMENTO]?.rotulo ?? f.status)}`);

  const principal: RelatorioTabela = {
    titulo: "Relatório de pagamentos",
    periodo,
    usuario: u.nome,
    natureza: "despesa",
    totalizar: true,
    aba: "Pagamentos",
    filtros: filtros.length > 1 ? filtros : [],
    resumo: [
      { rotulo: "Em aberto (R$)", valor: r.totais.aberto },
      { rotulo: "Vencido (R$)", valor: r.totais.vencido },
      { rotulo: "Pago (R$)", valor: r.totais.pago },
      { rotulo: "Total do período (R$)", valor: r.totais.total, destaque: true },
    ],
    colunas: [
      { titulo: "Vencimento", chave: "vencimento", largura: 8, tipo: "data" },
      { titulo: "Nº", chave: "numero", largura: 4, tipo: "numero", alinhar: "centro" },
      { titulo: "Descrição", chave: "descricao", largura: 22 },
      { titulo: "Favorecido / fornecedor", chave: "favorecido", largura: 16 },
      { titulo: "Categoria", chave: "categoria", largura: 12 },
      { titulo: "Centro de custo", chave: "obra", largura: 14 },
      { titulo: "Forma", chave: "forma", largura: 8 },
      { titulo: "Situação", chave: "situacao", largura: 10, tipo: "situacao" },
      { titulo: "Pago em", chave: "pago_em", largura: 8, tipo: "data" },
      { titulo: "Valor (R$)", chave: "valor", largura: 9, tipo: "moeda" },
    ],
    linhas: r.itens.map((p) => ({
      vencimento: p.vencimento,
      numero: p.numero,
      descricao: p.descricao,
      favorecido: p.fornecedor?.nome ?? p.favorecido,
      categoria: p.categoria?.nome ?? "",
      obra: p.obra?.nome ?? "",
      forma: FORMAS_PAGAMENTO[p.forma_pagamento],
      situacao: { texto: STATUS_PAGAMENTO[p.status].rotulo, cor: corDoStatus(p.status, !!p.vencido) },
      pago_em: p.pago_em,
      valor: Number(p.valor),
    })),
  };

  if (sp.get("formato") === "pdf") return respostaPdf(await gerarPdfRelatorio(principal), `relatorio-pagamentos-${f.de}-a-${f.ate}.pdf`);

  // Excel: a aba "Pagamentos" traz todas as colunas da planilha completa; as demais resumem por agrupamento
  const completa: RelatorioTabela = {
    ...principal,
    colunas: [
      { titulo: "Nº", chave: "numero", largura: 5, tipo: "numero", alinhar: "centro" },
      { titulo: "Vencimento", chave: "vencimento", largura: 9, tipo: "data" },
      { titulo: "Competência", chave: "competencia", largura: 9, tipo: "data" },
      { titulo: "Categoria", chave: "categoria", largura: 14 },
      { titulo: "Favorecido", chave: "favorecido", largura: 20 },
      { titulo: "Fornecedor", chave: "fornecedor", largura: 20 },
      { titulo: "CPF/CNPJ", chave: "doc", largura: 12 },
      { titulo: "Descrição", chave: "descricao", largura: 26 },
      { titulo: "Centro de custo", chave: "obra", largura: 16 },
      { titulo: "Cidade/UF", chave: "local", largura: 12 },
      { titulo: "Forma", chave: "forma", largura: 9 },
      { titulo: "Nº documento", chave: "numero_documento", largura: 10 },
      { titulo: "Situação", chave: "situacao", largura: 11, tipo: "situacao" },
      { titulo: "Pago em", chave: "pago_em", largura: 9, tipo: "data" },
      { titulo: "Valor (R$)", chave: "valor", largura: 10, tipo: "moeda" },
      { titulo: "Valor pago (R$)", chave: "valor_pago", largura: 10, tipo: "moeda" },
      { titulo: "Comprovante", chave: "comprovante", largura: 10 },
    ],
    linhas: r.itens.map((p) => ({
      numero: p.numero,
      vencimento: p.vencimento,
      competencia: p.data_competencia,
      categoria: p.categoria?.nome ?? "",
      favorecido: p.favorecido,
      fornecedor: p.fornecedor?.nome ?? "",
      doc: p.fornecedor?.cpf_cnpj ?? "",
      descricao: p.descricao,
      obra: p.obra?.nome ?? "",
      local: p.obra ? `${p.obra.cidade}/${p.obra.uf}` : "",
      forma: FORMAS_PAGAMENTO[p.forma_pagamento],
      numero_documento: p.numero_documento ?? "",
      situacao: { texto: STATUS_PAGAMENTO[p.status].rotulo + (p.vencido ? " (vencido)" : ""), cor: corDoStatus(p.status, !!p.vencido) },
      pago_em: p.pago_em,
      valor: Number(p.valor),
      valor_pago: p.valor_pago !== null ? Number(p.valor_pago) : null,
      comprovante: p.comprovante ? "Anexado" : p.status === "pago" ? "Pendente" : "",
    })),
  };
  const resumo = (aba: string, titulo: string, linhas: Record<string, unknown>[]): RelatorioTabela => ({
    titulo: `Pagamentos ${aba.toLowerCase()}`,
    periodo,
    usuario: u.nome,
    natureza: "despesa",
    aba,
    colunas: resumoColunas(titulo),
    linhas: linhas as RelatorioTabela["linhas"],
  });
  const buf = await gerarExcelRelatorio([
    completa,
    resumo("Por centro de custo", "Centro de custo", r.porObra),
    resumo("Por categoria", "Categoria", r.porCategoria),
    resumo("Por fornecedor", "Fornecedor / favorecido", r.porFornecedor),
    resumo("Por mês", "Mês (AAAA-MM)", r.porMes),
    resumo("Por situação", "Situação", r.porStatus),
  ]);
  return respostaXlsx(buf, `relatorio-pagamentos-${f.de}-a-${f.ate}.xlsx`);
}
