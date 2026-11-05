import { NextResponse, type NextRequest } from "next/server";
import { listarPagamentos } from "@/lib/consultas/pagamentos";
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
  const { itens } = await listarPagamentos(
    {
      busca: sp.get("busca") ?? "",
      obra: sp.get("obra") ?? "",
      fornecedor: sp.get("fornecedor") ?? "",
      status: sp.get("status") ?? "",
      de: sp.get("de") ?? "",
      ate: sp.get("ate") ?? "",
    },
    1,
    null,
  );

  const cab = ["Nº", "Vencimento", "Favorecido", "Fornecedor", "Descrição", "Centro de custo", "Cidade", "UF", "Valor", "Forma", "Nº documento", "Situação", "Pago em", "Valor pago"];
  const linhas = itens.map((p) =>
    [
      p.numero,
      data(p.vencimento),
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
