import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Abre/baixa um documento. O acesso é verificado pelo RLS (tabela documentos e
 * Storage): alterar o identificador na URL não dá acesso a documentos de obras
 * não autorizadas. O link gerado expira em 60 segundos.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/documentos/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Não encontrado", { status: 404 });

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.redirect(new URL("/login", request.url));

  const { data: doc } = await supabase.from("documentos").select("storage_path, nome_arquivo").eq("id", id).maybeSingle();
  if (!doc) return new NextResponse("Documento não encontrado ou sem permissão.", { status: 404 });

  const baixar = request.nextUrl.searchParams.has("baixar");
  const { data, error } = await supabase.storage
    .from("documentos")
    .createSignedUrl(doc.storage_path, 60, baixar ? { download: doc.nome_arquivo } : undefined);
  if (error || !data) return new NextResponse("Documento indisponível.", { status: 404 });

  return NextResponse.redirect(data.signedUrl, { headers: { "Cache-Control": "no-store" } });
}
