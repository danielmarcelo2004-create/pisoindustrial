import { lerPeriodo } from "@/lib/periodo";
import { NextResponse, type NextRequest } from "next/server";
import { listarPagamentos } from "@/lib/consultas/pagamentos";
import { listarContas, type FiltroCartao, type Situacao } from "@/lib/consultas/contas-a-pagar";
import { createClient } from "@/lib/supabase/server";
import { getUsuario } from "@/lib/auth";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { hojeISO } from "@/lib/formato";
import { gerarExcelRelatorio, gerarPdfRelatorio, respostaPdf, respostaXlsx, type CorSituacao, type RelatorioTabela } from "@/lib/relatorio-tabela";

const SITUACAO: Record<Situacao, { texto: string; cor: CorSituacao }> = {
  pago: { texto: "Pago", cor: "verde" },
  vencido: { texto: "Vencido", cor: "vermelho" },
  hoje: { texto: "Vence hoje", cor: "ambar" },
  a_pagar: { texto: "A pagar", cor: "azul" },
  aprovacao: { texto: "Em aprovação", cor: "ambar" },
  rejeitado: { texto: "Rejeitado", cor: "vermelho" },
  cancelado: { texto: "Cancelado", cor: "cinza" },
  provisao: { texto: "Provisão", cor: "cinza" },
};
const CARTAO: Record<string, string> = {
  vencidos: "Vencidos",
  hoje: "Vencem hoje",
  avencer: "A vencer",
  aprovacao: "Em aprovação",
  pagos: "Pagos",
  liberados: "Liberados para pagar",
  abertos: "Em aberto",
};

/**
 * Exporta Contas a pagar: Excel organizado (padrão) ou PDF para imprimir (formato=pdf), com a mesma lista, período e
 * filtros da tela. Sem "lista=contas", exporta os pagamentos selecionados/filtrados em Excel.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new NextResponse("Não autorizado", { status: 401 });
  const u = await getUsuario();

  const sp = request.nextUrl.searchParams;
  const pdf = sp.get("formato") === "pdf";

  if (sp.get("lista") === "contas") {
    const per = lerPeriodo({ periodo: sp.get("periodo") ?? "", mes: sp.get("mes") ?? "", de: sp.get("de") ?? "", ate: sp.get("ate") ?? "" }, hojeISO());
    const cartao = (sp.get("cartao") ?? "") as FiltroCartao;
    const { linhas, totais } = await listarContas({
      mes: per.tipo === "todos" ? "todos" : per.de.slice(0, 7),
      de: per.de,
      ate: per.ate,
      busca: sp.get("busca") ?? "",
      obra: sp.get("obra") ?? "",
      forma: sp.get("forma") ?? "",
      categoria: sp.get("categoria") ?? "",
      fornecedor: sp.get("fornecedor") ?? "",
      cartao,
      cancelados: sp.get("cancelados") === "1",
      conta: sp.get("conta") ?? "",
      lancados: sp.get("lancados") === "1",
    });

    // Descrição dos filtros aplicados (nomes, não códigos)
    const filtros: string[] = [`Período: ${per.rotulo}`];
    const nome = async (tabela: "obras" | "categorias" | "fornecedores" | "contas_bancarias", id: string) =>
      id ? ((await supabase.from(tabela).select("nome").eq("id", id).maybeSingle()).data?.nome ?? null) : null;
    const [nObra, nCat, nForn, nConta] = await Promise.all([nome("obras", sp.get("obra") ?? ""), nome("categorias", sp.get("categoria") ?? ""), nome("fornecedores", sp.get("fornecedor") ?? ""), nome("contas_bancarias", sp.get("conta") ?? "")]);
    if (sp.get("busca")) filtros.push(`Busca: ${sp.get("busca")}`);
    if (nObra) filtros.push(`Centro de custo: ${nObra}`);
    if (nCat) filtros.push(`Categoria: ${nCat}`);
    if (nForn) filtros.push(`Fornecedor: ${nForn}`);
    if (nConta) filtros.push(`Conta bancária: ${nConta}`);
    if (sp.get("forma") && sp.get("forma")! in FORMAS_PAGAMENTO) filtros.push(`Forma de pagamento: ${FORMAS_PAGAMENTO[sp.get("forma") as keyof typeof FORMAS_PAGAMENTO]}`);
    if (cartao && CARTAO[cartao]) filtros.push(`Situação: ${CARTAO[cartao]}`);
    if (sp.get("cancelados") === "1") filtros.push("Inclui cancelados");
    if (sp.get("lancados") === "1") filtros.push("Somente lançados pela conciliação");

    const rel: RelatorioTabela = {
      titulo: "Contas a pagar",
      periodo: per.rotulo,
      usuario: u.nome,
      natureza: "despesa",
      totalizar: true,
      aba: "Contas a pagar",
      filtros: filtros.length > 1 ? filtros : [],
      resumo: [
        { rotulo: "Vencidos (R$)", valor: totais.vencidos.valor },
        { rotulo: "Vencem hoje (R$)", valor: totais.hoje.valor },
        { rotulo: "A vencer (R$)", valor: totais.avencer.valor },
        { rotulo: "Em aprovação (R$)", valor: totais.aprovacao.valor },
        { rotulo: "Pagos (R$)", valor: totais.pagos.valor },
        { rotulo: "Total do período (R$)", valor: totais.total.valor, destaque: true },
      ],
      colunas: [
        { titulo: "Vencimento", chave: "vencimento", largura: 8, tipo: "data" },
        { titulo: "Nº", chave: "numero", largura: 5, tipo: "numero", alinhar: "centro" },
        { titulo: "Descrição", chave: "descricao", largura: 22 },
        { titulo: "Favorecido", chave: "favorecido", largura: 16 },
        { titulo: "Categoria", chave: "categoria", largura: 12 },
        { titulo: "Centro de custo", chave: "obra", largura: 14 },
        { titulo: "Forma", chave: "forma", largura: 8 },
        { titulo: "Situação", chave: "situacao", largura: 13, tipo: "situacao" },
        { titulo: "Pago em", chave: "pagoEm", largura: 8, tipo: "data" },
        { titulo: "Valor (R$)", chave: "valor", largura: 9, tipo: "moeda" },
      ],
      linhas: linhas.map((l) => {
        const sit = SITUACAO[l.situacao];
        const parcela = l.parcela ? ` (parcela ${l.parcela.n}/${l.parcela.total})` : l.repeticao ? ` (${l.repeticao})` : "";
        return {
          vencimento: l.vencimento,
          numero: l.numero,
          descricao: `${l.descricao}${parcela}`,
          favorecido: l.favorecido,
          categoria: l.categoria ?? "",
          obra: l.obra ?? "",
          forma: l.forma ? FORMAS_PAGAMENTO[l.forma] : "",
          situacao: { texto: l.statusPagamento && (l.situacao === "aprovacao" || l.situacao === "rejeitado") ? STATUS_PAGAMENTO[l.statusPagamento].rotulo : sit.texto, cor: sit.cor },
          pagoEm: l.pagoEm,
          valor: l.valor,
        };
      }),
    };
    if (pdf) return respostaPdf(await gerarPdfRelatorio(rel), `contas-a-pagar-${hojeISO()}.pdf`);
    return respostaXlsx(await gerarExcelRelatorio([rel]), `contas-a-pagar-${hojeISO()}.xlsx`);
  }

  const { itens } = await listarPagamentos(
    {
      busca: sp.get("busca") ?? "",
      obra: sp.get("obra") ?? "",
      fornecedor: sp.get("fornecedor") ?? "",
      status: sp.get("status") ?? "",
      de: sp.get("de") ?? "",
      ate: sp.get("ate") ?? "",
      ...(sp.get("ids") !== null ? { ids: (sp.get("ids") ?? "").split(",").filter(Boolean).slice(0, 500) } : {}),
    },
    1,
    null,
  );
  const rel: RelatorioTabela = {
    titulo: "Pagamentos",
    periodo: sp.get("ids") !== null ? "Seleção" : "Filtro da lista",
    usuario: u.nome,
    natureza: "despesa",
    totalizar: true,
    aba: "Pagamentos",
    colunas: [
      { titulo: "Nº", chave: "numero", largura: 4, tipo: "numero", alinhar: "centro" },
      { titulo: "Vencimento", chave: "vencimento", largura: 8, tipo: "data" },
      { titulo: "Competência", chave: "competencia", largura: 8, tipo: "data" },
      { titulo: "Categoria", chave: "categoria", largura: 12 },
      { titulo: "Favorecido", chave: "favorecido", largura: 16 },
      { titulo: "Fornecedor", chave: "fornecedor", largura: 16 },
      { titulo: "Descrição", chave: "descricao", largura: 24 },
      { titulo: "Centro de custo", chave: "obra", largura: 14 },
      { titulo: "Forma", chave: "forma", largura: 8 },
      { titulo: "Nº documento", chave: "numero_documento", largura: 10 },
      { titulo: "Situação", chave: "situacao", largura: 10 },
      { titulo: "Pago em", chave: "pago_em", largura: 8, tipo: "data" },
      { titulo: "Valor (R$)", chave: "valor", largura: 9, tipo: "moeda" },
      { titulo: "Valor pago (R$)", chave: "valor_pago", largura: 9, tipo: "moeda" },
    ],
    linhas: itens.map((p) => ({
      numero: p.numero,
      vencimento: p.vencimento,
      competencia: p.data_competencia,
      categoria: p.categoria?.nome ?? "",
      favorecido: p.favorecido,
      fornecedor: p.fornecedor?.nome ?? "",
      descricao: p.descricao,
      obra: p.obra?.nome ?? "",
      forma: FORMAS_PAGAMENTO[p.forma_pagamento],
      numero_documento: p.numero_documento ?? "",
      situacao: STATUS_PAGAMENTO[p.status].rotulo,
      pago_em: p.pago_em,
      valor: Number(p.valor),
      valor_pago: p.valor_pago !== null ? Number(p.valor_pago) : null,
    })),
  };
  return respostaXlsx(await gerarExcelRelatorio([rel]), `pagamentos-${hojeISO()}.xlsx`);
}
