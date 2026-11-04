import { NextResponse, type NextRequest } from "next/server";
import { carregarOP, dadosPdf } from "@/lib/consultas/ops";
import { gerarPdfOP } from "@/lib/pdf-op";
import { createClient } from "@/lib/supabase/server";

/** Pré-visualização do PDF da OP (o RLS limita a quem pode ver a solicitação). */
export async function GET(request: NextRequest, ctx: RouteContext<"/ops/[id]/pdf">) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: c } = await supabase.auth.getClaims();
  if (!c?.claims?.sub) return NextResponse.redirect(new URL("/login", request.url));
  const op = await carregarOP(id);
  if (!op) return new NextResponse("Solicitação não encontrada.", { status: 404 });
  const bytes = await gerarPdfOP(dadosPdf(op));
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${op.numero ?? "rascunho-op"}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
