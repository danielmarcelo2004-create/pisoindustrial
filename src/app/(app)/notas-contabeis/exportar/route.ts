import { NextResponse, type NextRequest } from "next/server";
import { gerarExcel, respostaExcel } from "@/lib/excel";
import { listarNotasContabeis, type SituacaoNota } from "@/lib/consultas/notas-contabeis";
import { ROTULO_CATEGORIA } from "@/lib/notas-contabeis";
import { createClient } from "@/lib/supabase/server";

/** Planilha das notas para a contabilidade, com as retenções em colunas próprias. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new NextResponse("Não autorizado", { status: 401 });

  const s = request.nextUrl.searchParams.get("situacao");
  const situacao: SituacaoNota = s === "enviadas" || s === "todas" ? s : "pendentes";
  const notas = await listarNotasContabeis(situacao);
  const linhas = notas.map((n) => ({
    emissao: n.data_emissao ? new Date(`${n.data_emissao}T12:00:00`) : null,
    categoria: ROTULO_CATEGORIA[n.categoria],
    prestador: n.prestador_nome ?? "",
    documento: n.prestador_documento ?? "",
    numero: n.numero ?? "",
    valor: n.valor,
    inss: n.retencoes?.inss ?? 0,
    irrf: n.retencoes?.irrf ?? 0,
    csrf: n.retencoes?.csrf ?? 0,
    iss: n.retencoes?.iss ?? 0,
    obra: n.obra?.nome ?? "",
    pagamento: n.pagamento?.descricao ?? "",
    arquivo: n.documento?.nome_arquivo ?? "",
    enviada: n.enviada_em ? "Sim" : "Não",
  }));
  const buf = await gerarExcel([
    {
      nome: "Notas para contabilidade",
      colunas: [
        { titulo: "Emissão", chave: "emissao", formato: "data", largura: 12 },
        { titulo: "Categoria", chave: "categoria", largura: 34 },
        { titulo: "Prestador", chave: "prestador", largura: 36 },
        { titulo: "CPF/CNPJ", chave: "documento", largura: 20 },
        { titulo: "Nº", chave: "numero", largura: 10 },
        { titulo: "Valor", chave: "valor", formato: "moeda", largura: 14 },
        { titulo: "INSS", chave: "inss", formato: "moeda", largura: 12 },
        { titulo: "IRRF", chave: "irrf", formato: "moeda", largura: 12 },
        { titulo: "CSRF", chave: "csrf", formato: "moeda", largura: 12 },
        { titulo: "ISS", chave: "iss", formato: "moeda", largura: 12 },
        { titulo: "Obra", chave: "obra", largura: 28 },
        { titulo: "Pagamento", chave: "pagamento", largura: 40 },
        { titulo: "Arquivo", chave: "arquivo", largura: 30 },
        { titulo: "Enviada", chave: "enviada", largura: 10 },
      ],
      linhas,
    },
  ]);
  return respostaExcel(buf, `notas-contabilidade-${situacao}.xlsx`);
}
