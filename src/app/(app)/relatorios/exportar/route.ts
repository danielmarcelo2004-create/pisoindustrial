import { type NextRequest } from "next/server";
import { dadosRelatorio, lerFiltros } from "@/lib/consultas/relatorios";
import { corDoStatus, extratoRelatorio, type LinhaExtrato } from "@/lib/consultas/extrato";
import { gerarExcelRelatorio, gerarPdfRelatorio, respostaPdf, respostaXlsx, type ColunaRel, type RelatorioTabela } from "@/lib/relatorio-tabela";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { getUsuario } from "@/lib/auth";
import { data as dataBR } from "@/lib/formato";

const STATUS_ROTULO: Record<string, string> = { abertos: "Em aberto", realizados: "Realizados (pagos/recebidos)", cancelado: "Cancelados" };

/** Soma o extrato por um agrupamento: receitas, despesas e saldo. */
function agrupar(linhas: LinhaExtrato[], chave: (l: LinhaExtrato) => string): Record<string, string | number>[] {
  const m = new Map<string, { rotulo: string; receitas: number; despesas: number }>();
  for (const l of linhas) {
    if (l.cancelada) continue;
    const k = chave(l);
    const r = m.get(k) ?? { rotulo: k, receitas: 0, despesas: 0 };
    if (l.tipo === "receita") r.receitas += l.valor;
    else r.despesas += Math.abs(l.valor);
    m.set(k, r);
  }
  return [...m.values()].map((r) => ({ ...r, saldo: r.receitas - r.despesas })).sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
}

const colunasAgrupadas = (titulo: string): ColunaRel[] => [
  { titulo, chave: "rotulo", largura: 30 },
  { titulo: "Receitas (R$)", chave: "receitas", largura: 14, tipo: "moeda" },
  { titulo: "Despesas (R$)", chave: "despesas", largura: 14, tipo: "moeda" },
  { titulo: "Saldo (R$)", chave: "saldo", largura: 14, tipo: "moeda" },
];

/**
 * Relatório em formato de extrato (receitas e despesas juntas), com os filtros da tela: Excel organizado (abas) ou PDF
 * para imprimir (formato=pdf). Só entra o que está dentro do período e dos filtros.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: c } = await supabase.auth.getClaims();
  if (!c?.claims?.sub) return new Response("Não autorizado", { status: 401 });
  const u = await getUsuario();
  const sp = request.nextUrl.searchParams;
  const f = lerFiltros((k) => sp.get(k));
  const { linhas, totais, truncado } = await extratoRelatorio(f);

  const baseRotulo = { vencimento: "vencimento", pago_em: "pagamento/recebimento", criacao: "cadastro", data_competencia: "competência" }[f.base];
  const periodo = `${dataBR(f.de)} a ${dataBR(f.ate)} (por ${baseRotulo})`;
  const nome = async (tabela: "obras" | "categorias" | "fornecedores", id?: string) =>
    id && id !== "sem" ? ((await supabase.from(tabela).select("nome").eq("id", id).maybeSingle()).data?.nome ?? null) : null;
  const [nObra, nCat, nForn] = await Promise.all([nome("obras", f.obra), nome("categorias", f.categoria), nome("fornecedores", f.fornecedor)]);
  const filtros: string[] = [`Período: ${periodo}`];
  if (f.tipo) filtros.push(`Tipo: ${f.tipo === "receitas" ? "somente receitas" : "somente despesas"}`);
  if (f.busca) filtros.push(`Busca: ${f.busca}`);
  if (nObra) filtros.push(`Centro de custo: ${nObra}`);
  if (nCat) filtros.push(`Categoria: ${nCat}`);
  if (f.categoria === "sem") filtros.push("Categoria: sem categoria");
  if (nForn) filtros.push(`Fornecedor: ${nForn} (somente despesas)`);
  if (f.status) filtros.push(`Situação: ${STATUS_ROTULO[f.status] ?? STATUS_PAGAMENTO[f.status as keyof typeof STATUS_PAGAMENTO]?.rotulo ?? f.status}`);
  if (truncado) filtros.push("Atenção: o filtro tem lançamentos demais; reduza o período para ver tudo");

  const extrato: RelatorioTabela = {
    titulo: "Relatório de extrato",
    periodo,
    usuario: u.nome,
    natureza: "misto",
    totalizar: true,
    aba: "Extrato",
    filtros: filtros.length > 1 ? filtros : [],
    resumo: [
      { rotulo: "Receitas em aberto (R$)", valor: totais.receitasAbertas },
      { rotulo: "Receitas realizadas (R$)", valor: totais.receitasRealizadas },
      { rotulo: "Despesas em aberto (R$)", valor: totais.despesasAbertas },
      { rotulo: "Despesas realizadas (R$)", valor: totais.despesasRealizadas },
      { rotulo: "Totais do período (R$)", valor: totais.saldo, destaque: true },
    ],
    colunas: [
      { titulo: "Data", chave: "data", largura: 8, tipo: "data" },
      { titulo: "Tipo", chave: "tipo", largura: 6 },
      { titulo: "Descrição", chave: "descricao", largura: 24 },
      { titulo: "Cliente / fornecedor", chave: "parte", largura: 16 },
      { titulo: "Categoria", chave: "categoria", largura: 12 },
      { titulo: "Centro de custo", chave: "obra", largura: 14 },
      { titulo: "Situação", chave: "situacao", largura: 12, tipo: "situacao" },
      { titulo: "Valor (R$)", chave: "valor", largura: 10, tipo: "moeda" },
    ],
    linhas: linhas.map((l) => ({
      data: l.data,
      tipo: l.tipo === "receita" ? "Receita" : "Despesa",
      descricao: l.descricao,
      parte: l.parte,
      categoria: l.categoria ?? "",
      obra: l.obra ?? "",
      situacao: { texto: l.situacao, cor: l.cor },
      valor: l.valor,
    })),
  };

  if (sp.get("formato") === "pdf") return respostaPdf(await gerarPdfRelatorio(extrato), `relatorio-extrato-${f.de}-a-${f.ate}.pdf`);

  const grupo = (aba: string, titulo: string, chave: (l: LinhaExtrato) => string): RelatorioTabela => ({
    titulo: `Extrato ${aba.toLowerCase()}`,
    periodo,
    usuario: u.nome,
    natureza: "misto",
    aba,
    colunas: colunasAgrupadas(titulo),
    linhas: agrupar(linhas, chave) as RelatorioTabela["linhas"],
  });
  const abas: RelatorioTabela[] = [
    extrato,
    grupo("Por centro de custo", "Centro de custo", (l) => l.obra ?? "—"),
    grupo("Por categoria", "Categoria", (l) => l.categoria ?? "Sem categoria"),
    grupo("Por fornecedor ou cliente", "Fornecedor / cliente", (l) => l.parte),
    grupo("Por mês", "Mês (AAAA-MM)", (l) => (l.data ?? "").slice(0, 7) || "—"),
  ];

  // Detalhe das despesas (CPF/CNPJ, forma de pagamento, comprovante) — só quando o relatório inclui despesas
  if (f.tipo !== "receitas") {
    const r = await dadosRelatorio(f);
    abas.push({
      titulo: "Despesas em detalhe",
      periodo,
      usuario: u.nome,
      natureza: "despesa",
      totalizar: true,
      aba: "Despesas (detalhe)",
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
        { titulo: "Forma", chave: "forma", largura: 9 },
        { titulo: "Nº documento", chave: "numero_documento", largura: 10 },
        { titulo: "Situação", chave: "situacao", largura: 13, tipo: "situacao" },
        { titulo: "Pago em", chave: "pago_em", largura: 9, tipo: "data" },
        { titulo: "Valor (R$)", chave: "valor", largura: 10, tipo: "moeda" },
        { titulo: "Valor pago (R$)", chave: "valor_pago", largura: 10, tipo: "moeda" },
        { titulo: "Comprovante", chave: "comprovante", largura: 11 },
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
        forma: FORMAS_PAGAMENTO[p.forma_pagamento],
        numero_documento: p.numero_documento ?? "",
        situacao: { texto: STATUS_PAGAMENTO[p.status].rotulo + (p.vencido ? " (vencido)" : ""), cor: corDoStatus(p.status, !!p.vencido) },
        pago_em: p.pago_em,
        valor: Number(p.valor),
        valor_pago: p.valor_pago !== null ? Number(p.valor_pago) : null,
        comprovante: p.comprovante ? "Anexado" : p.status === "pago" ? "Pendente" : "",
      })),
    });
  }
  return respostaXlsx(await gerarExcelRelatorio(abas), `relatorio-extrato-${f.de}-a-${f.ate}.xlsx`);
}
