import { NextResponse, type NextRequest } from "next/server";
import { listarRecebimentos, type FiltroCartaoReceber, type SituacaoReceber } from "@/lib/consultas/contas-a-receber";
import { createClient } from "@/lib/supabase/server";
import { getUsuario } from "@/lib/auth";
import { hojeISO } from "@/lib/formato";
import { lerPeriodo } from "@/lib/periodo";
import { gerarExcelRelatorio, gerarPdfRelatorio, respostaPdf, respostaXlsx, type CorSituacao, type RelatorioTabela } from "@/lib/relatorio-tabela";

const SITUACAO: Record<SituacaoReceber, { texto: string; cor: CorSituacao }> = {
  recebido: { texto: "Recebido", cor: "verde" },
  vencido: { texto: "Vencido", cor: "vermelho" },
  hoje: { texto: "Vence hoje", cor: "ambar" },
  a_receber: { texto: "A receber", cor: "azul" },
  cancelado: { texto: "Cancelado", cor: "cinza" },
};
const CARTAO: Record<string, string> = { vencidos: "Vencidos", hoje: "Vencem hoje", avencer: "A vencer", recebidos: "Recebidos" };
const CARTOES: FiltroCartaoReceber[] = ["vencidos", "hoje", "avencer", "recebidos"];

/** Exporta Contas a receber (mesma lista, período e filtros da tela): Excel organizado ou PDF para imprimir (formato=pdf). */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new NextResponse("Não autorizado", { status: 401 });
  const u = await getUsuario();
  const sp = request.nextUrl.searchParams;
  const hoje = hojeISO();
  const per = lerPeriodo({ periodo: sp.get("periodo") ?? "", mes: sp.get("mes") ?? "", de: sp.get("de") ?? "", ate: sp.get("ate") ?? "" }, hoje, "mes");
  const cartaoParam = (sp.get("cartao") ?? "") as FiltroCartaoReceber;
  const cartao: FiltroCartaoReceber = CARTOES.includes(cartaoParam) ? cartaoParam : "";
  const veBanco = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const { linhas, totais } = await listarRecebimentos(
    {
      periodo: per.tipo,
      de: per.de,
      ate: per.ate,
      busca: sp.get("busca") ?? "",
      obra: sp.get("obra") ?? "",
      categoria: sp.get("categoria") ?? "",
      conta: sp.get("conta") ?? "",
      cancelados: sp.get("cancelados") === "1",
      semtransf: sp.get("semtransf") === "1",
      cartao,
    },
    hoje,
    veBanco,
  );

  const nome = async (tabela: "obras" | "categorias" | "contas_bancarias", id: string) =>
    id ? ((await supabase.from(tabela).select("nome").eq("id", id).maybeSingle()).data?.nome ?? null) : null;
  const [nObra, nCat, nConta] = await Promise.all([nome("obras", sp.get("obra") ?? ""), nome("categorias", sp.get("categoria") ?? ""), nome("contas_bancarias", sp.get("conta") ?? "")]);
  const filtros: string[] = [`Período: ${per.rotulo}`];
  if (sp.get("busca")) filtros.push(`Busca: ${sp.get("busca")}`);
  if (nObra) filtros.push(`Centro de custo: ${nObra}`);
  if (nCat) filtros.push(`Categoria: ${nCat}`);
  if (nConta) filtros.push(`Conta bancária: ${nConta}`);
  if (cartao) filtros.push(`Situação: ${CARTAO[cartao]}`);
  if (sp.get("cancelados") === "1") filtros.push("Inclui cancelados");
  if (sp.get("semtransf") === "1") filtros.push("Sem transferências entre contas");

  const rel: RelatorioTabela = {
    titulo: "Contas a receber",
    periodo: per.rotulo,
    usuario: u.nome,
    natureza: "receita",
    totalizar: true,
    aba: "Contas a receber",
    filtros: filtros.length > 1 ? filtros : [],
    resumo: [
      { rotulo: "Vencidos (R$)", valor: totais.vencidos.valor },
      { rotulo: "Vencem hoje (R$)", valor: totais.hoje.valor },
      { rotulo: "A vencer (R$)", valor: totais.avencer.valor },
      { rotulo: "Recebidos (R$)", valor: totais.recebidos.valor },
      { rotulo: "Total do período (R$)", valor: totais.total.valor, destaque: true },
    ],
    colunas: [
      { titulo: "Vencimento", chave: "vencimento", largura: 8, tipo: "data" },
      { titulo: "Nº", chave: "numero", largura: 4, tipo: "numero", alinhar: "centro" },
      { titulo: "Descrição", chave: "descricao", largura: 24 },
      { titulo: "Cliente", chave: "cliente", largura: 16 },
      { titulo: "Categoria", chave: "categoria", largura: 12 },
      { titulo: "Centro de custo", chave: "obra", largura: 14 },
      { titulo: "Conta", chave: "conta", largura: 11 },
      { titulo: "Situação", chave: "situacao", largura: 9, tipo: "situacao" },
      { titulo: "Recebido em", chave: "recebidoEm", largura: 8, tipo: "data" },
      { titulo: "Valor (R$)", chave: "valor", largura: 9, tipo: "moeda" },
    ],
    linhas: linhas.map((l) => ({
      vencimento: l.vencimento,
      numero: l.numero,
      descricao: l.tipo === "transferencia" ? `${l.descricao} (transferência entre contas)` : l.descricao,
      cliente: l.cliente,
      categoria: l.categoria ?? "",
      obra: l.obra ?? "",
      conta: l.conta ?? "",
      situacao: SITUACAO[l.situacao],
      recebidoEm: l.recebidoEm,
      valor: l.valor,
    })),
  };
  if (sp.get("formato") === "pdf") return respostaPdf(await gerarPdfRelatorio(rel), `contas-a-receber-${hoje}.pdf`);
  return respostaXlsx(await gerarExcelRelatorio([rel]), `contas-a-receber-${hoje}.xlsx`);
}
