import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function sair(request: NextRequest, motivo: string) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  const url = new URL("/login", request.url);
  url.searchParams.set("motivo", motivo);
  return NextResponse.redirect(url, { status: 303 });
}

/** Saída pelo botão "Sair" (formulário POST). */
export async function POST(request: NextRequest) {
  return sair(request, "saiu");
}

/** Usado quando o usuário foi desativado durante a sessão. */
export async function GET(request: NextRequest) {
  const motivo = request.nextUrl.searchParams.get("motivo") === "inativo" ? "inativo" : "saiu";
  return sair(request, motivo);
}
