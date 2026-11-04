import { type NextRequest } from "next/server";
import { agruparMateriais, alertasPreco, itensCompras } from "@/lib/consultas/compras";
import { gerarExcel, respostaExcel } from "@/lib/excel";
import { hojeISO } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: c } = await supabase.auth.getClaims();
  if (!c?.claims?.sub) return new Response("Não autorizado", { status: 401 });
  const sp = request.nextUrl.searchParams;
  const g = (k: string) => sp.get(k) ?? "";
  const itens = await itensCompras({ material: g("material"), fornecedor: g("fornecedor"), obra: g("obra"), cidade: g("cidade"), uf: g("uf"), de: g("de"), ate: g("ate") });
  const grupos = agruparMateriais(itens);
  const alertas = alertasPreco(itens, grupos);

  const buf = await gerarExcel([
    {
      nome: "Itens das notas",
      colunas: [
        { titulo: "Emissão", chave: "data_emissao", formato: "data", largura: 12 },
        { titulo: "NF", chave: "nf_numero", largura: 10 },
        { titulo: "Fornecedor", chave: "fornecedor_nome", largura: 32 },
        { titulo: "CNPJ", chave: "fornecedor_cnpj", largura: 18 },
        { titulo: "Obra", chave: "obra_nome", largura: 28 },
        { titulo: "Cidade", chave: "cidade", largura: 18 },
        { titulo: "UF", chave: "uf", largura: 6 },
        { titulo: "Código", chave: "codigo", largura: 12 },
        { titulo: "Descrição", chave: "descricao", largura: 48 },
        { titulo: "NCM", chave: "ncm", largura: 11 },
        { titulo: "Unidade", chave: "unidade", largura: 9 },
        { titulo: "Quantidade", chave: "quantidade", formato: "numero", largura: 12 },
        { titulo: "Preço unitário", chave: "valor_unitario", formato: "preco", largura: 15 },
        { titulo: "Total", chave: "valor_total", formato: "moeda", largura: 15 },
        { titulo: "Origem", chave: "origem", largura: 9 },
      ],
      linhas: itens,
    },
    {
      nome: "Comparação por material",
      colunas: [
        { titulo: "Material", chave: "descricao", largura: 48 },
        { titulo: "Unidade", chave: "unidade", largura: 9 },
        { titulo: "Compras", chave: "compras", formato: "numero", largura: 10 },
        { titulo: "Quantidade", chave: "quantidade", formato: "numero", largura: 12 },
        { titulo: "Menor preço", chave: "precoMin", formato: "preco" },
        { titulo: "Preço médio", chave: "precoMedio", formato: "preco" },
        { titulo: "Mediana", chave: "precoMediana", formato: "preco" },
        { titulo: "Maior preço", chave: "precoMax", formato: "preco" },
        { titulo: "Último preço", chave: "ultimoPreco", formato: "preco" },
        { titulo: "Última compra", chave: "ultimaData", formato: "data", largura: 13 },
        { titulo: "Fornecedores", chave: "fornecedores", formato: "numero", largura: 12 },
        { titulo: "Valor total", chave: "valorTotal", formato: "moeda" },
      ],
      linhas: grupos,
    },
    {
      nome: "Alertas",
      colunas: [
        { titulo: "Emissão", chave: "data", formato: "data", largura: 12 },
        { titulo: "Material", chave: "descricao", largura: 48 },
        { titulo: "Unidade", chave: "unidade", largura: 9 },
        { titulo: "Fornecedor", chave: "fornecedor", largura: 32 },
        { titulo: "Obra", chave: "obra", largura: 28 },
        { titulo: "Preço", chave: "preco", formato: "preco" },
        { titulo: "Mediana", chave: "mediana", formato: "preco" },
        { titulo: "Diferença (%)", chave: "diferenca", formato: "numero", largura: 13 },
        { titulo: "Observação", chave: "obs", largura: 60 },
      ],
      linhas: alertas.map((a) => ({
        data: a.item.data_emissao,
        descricao: a.item.descricao,
        unidade: a.item.unidade,
        fornecedor: a.item.fornecedor_nome,
        obra: a.item.obra_nome,
        preco: a.item.valor_unitario,
        mediana: a.mediana,
        diferenca: Math.round(a.diferenca * 1000) / 10,
        obs: "Indicador para análise; confira equivalência técnica, frete, impostos e condições.",
      })),
    },
  ]);
  return respostaExcel(buf, `inteligencia-compras-${hojeISO()}.xlsx`);
}
