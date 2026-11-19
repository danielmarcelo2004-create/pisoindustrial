import { NextResponse, type NextRequest } from "next/server";
import { listarPagamentos } from "@/lib/consultas/pagamentos";
import { listarContas, type FiltroCartao } from "@/lib/consultas/contas-a-pagar";
import { createClient } from "@/lib/supabase/server";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { data, hojeISO } from "@/lib/formato";

function celula(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  // Evita injeção de fórmulas ao abrir no Excel.
  const seguro = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** Exporta os pagamentos filtrados em CSV (abre direto no Excel, separador ";"). */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new NextResponse("Não autorizado", { status: 401 });

  const sp = request.nextUrl.searchParams;

  // Exportar planilha da tela "Contas a pagar": as mesmas linhas da lista (uma por conta/parcela), com os mesmos filtros
  if (sp.get("lista") === "contas") {
    const mesP = sp.get("mes") ?? "";
    const { linhas } = await listarContas({
      mes: /^\d{4}-\d{2}$/.test(mesP) || mesP === "todos" ? mesP : hojeISO().slice(0, 7),
      de: sp.get("de") ?? "",
      ate: sp.get("ate") ?? "",
      busca: sp.get("busca") ?? "",
      obra: sp.get("obra") ?? "",
      forma: sp.get("forma") ?? "",
      categoria: sp.get("categoria") ?? "",
      fornecedor: sp.get("fornecedor") ?? "",
      cartao: (sp.get("cartao") ?? "") as FiltroCartao,
      cancelados: sp.get("cancelados") === "1",
    });
    const cab = ["Vencimento", "Nº", "Parcela", "Favorecido", "Descrição", "Categoria", "Centro de custo", "Forma", "Valor", "A pagar", "Situação", "Pago em"];
    const rotSit: Record<string, string> = { pago: "Pago", vencido: "Vencido", hoje: "Vence hoje", a_pagar: "A pagar", aprovacao: "Em aprovação", rejeitado: "Rejeitado", cancelado: "Cancelado", provisao: "Provisão" };
    const corpo = linhas.map((l) =>
      [
        data(l.vencimento),
        l.numero ?? "",
        l.parcela ? `${l.parcela.n}/${l.parcela.total}` : l.repeticao ?? "",
        l.favorecido,
        l.descricao,
        l.categoria ?? "",
        l.obra ?? "",
        l.forma ? FORMAS_PAGAMENTO[l.forma] : "",
        l.valor.toFixed(2).replace(".", ","),
        l.tipo === "provisao" ? "" : l.aPagar.toFixed(2).replace(".", ","),
        l.statusPagamento && (l.situacao === "aprovacao" || l.situacao === "rejeitado") ? STATUS_PAGAMENTO[l.statusPagamento].rotulo : rotSit[l.situacao],
        l.pagoEm ? data(l.pagoEm) : "",
      ]
        .map(celula)
        .join(";"),
    );
    return new NextResponse("\uFEFF" + [cab.join(";"), ...corpo].join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contas-a-pagar-${hojeISO()}.csv"`,
        "Cache-Control": "no-store",
      },
    });
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

  const cab = ["Nº", "Vencimento", "Competência", "Categoria", "Favorecido", "Fornecedor", "Descrição", "Centro de custo", "Cidade", "UF", "Valor", "Forma", "Nº documento", "Situação", "Pago em", "Valor pago"];
  const linhas = itens.map((p) =>
    [
      p.numero,
      data(p.vencimento),
      data(p.data_competencia),
      p.categoria?.nome ?? "",
      p.favorecido,
      p.fornecedor?.nome ?? "",
      p.descricao,
      p.obra?.nome ?? "",
      p.obra?.cidade ?? "",
      p.obra?.uf ?? "",
      Number(p.valor).toFixed(2).replace(".", ","),
      FORMAS_PAGAMENTO[p.forma_pagamento],
      p.numero_documento ?? "",
      STATUS_PAGAMENTO[p.status].rotulo,
      p.pago_em ? data(p.pago_em) : "",
      p.valor_pago !== null ? Number(p.valor_pago).toFixed(2).replace(".", ",") : "",
    ]
      .map(celula)
      .join(";"),
  );
  const csv = "﻿" + [cab.join(";"), ...linhas].join("\r\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pagamentos-${hojeISO()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
