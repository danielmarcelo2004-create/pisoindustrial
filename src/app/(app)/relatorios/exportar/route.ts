import { type NextRequest } from "next/server";
import { dadosRelatorio, lerFiltros } from "@/lib/consultas/relatorios";
import { gerarExcel, respostaExcel, type Coluna } from "@/lib/excel";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

const resumo = (titulo: string): Coluna[] => [
  { titulo, chave: "rotulo", largura: 36 },
  { titulo: "Quantidade", chave: "qtd", formato: "numero", largura: 12 },
  { titulo: "Total", chave: "total", formato: "moeda" },
  { titulo: "Pago", chave: "pago", formato: "moeda" },
  { titulo: "Em aberto", chave: "aberto", formato: "moeda" },
  { titulo: "Vencido", chave: "vencido", formato: "moeda" },
];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: c } = await supabase.auth.getClaims();
  if (!c?.claims?.sub) return new Response("Não autorizado", { status: 401 });
  const f = lerFiltros((k) => request.nextUrl.searchParams.get(k));
  const r = await dadosRelatorio(f);
  const buf = await gerarExcel([
    {
      nome: "Pagamentos",
      colunas: [
        { titulo: "Nº", chave: "numero", formato: "numero", largura: 8 },
        { titulo: "Vencimento", chave: "vencimento", formato: "data", largura: 12 },
        { titulo: "Favorecido", chave: "favorecido", largura: 32 },
        { titulo: "Fornecedor", chave: "fornecedor", largura: 32 },
        { titulo: "CPF/CNPJ", chave: "doc", largura: 18 },
        { titulo: "Descrição", chave: "descricao", largura: 44 },
        { titulo: "Obra", chave: "obra", largura: 28 },
        { titulo: "Cidade/UF", chave: "local", largura: 20 },
        { titulo: "Valor", chave: "valor", formato: "moeda" },
        { titulo: "Forma", chave: "forma", largura: 14 },
        { titulo: "Nº documento", chave: "numero_documento", largura: 14 },
        { titulo: "Situação", chave: "situacao", largura: 22 },
        { titulo: "Vencido", chave: "vencido", largura: 9 },
        { titulo: "Pago em", chave: "pago_em", formato: "data", largura: 12 },
        { titulo: "Valor pago", chave: "valor_pago", formato: "moeda" },
        { titulo: "Comprovante", chave: "comprovante", largura: 12 },
      ],
      linhas: r.itens.map((p) => ({
        numero: p.numero,
        vencimento: p.vencimento,
        favorecido: p.favorecido,
        fornecedor: p.fornecedor?.nome ?? "",
        doc: p.fornecedor?.cpf_cnpj ?? "",
        descricao: p.descricao,
        obra: p.obra?.nome ?? "",
        local: p.obra ? `${p.obra.cidade}/${p.obra.uf}` : "",
        valor: p.valor,
        forma: FORMAS_PAGAMENTO[p.forma_pagamento],
        numero_documento: p.numero_documento ?? "",
        situacao: STATUS_PAGAMENTO[p.status].rotulo,
        vencido: p.vencido ? "Sim" : "",
        pago_em: p.pago_em ?? "",
        valor_pago: p.valor_pago,
        comprovante: p.comprovante ? "Anexado" : p.status === "pago" ? "Pendente" : "",
      })),
    },
    { nome: "Por obra", colunas: resumo("Obra"), linhas: r.porObra },
    { nome: "Por fornecedor", colunas: resumo("Fornecedor / favorecido"), linhas: r.porFornecedor },
    { nome: "Por mês", colunas: resumo("Mês (AAAA-MM)"), linhas: r.porMes },
    { nome: "Por situação", colunas: resumo("Situação"), linhas: r.porStatus },
  ]);
  return respostaExcel(buf, `relatorio-pagamentos-${f.de}-a-${f.ate}.xlsx`);
}
