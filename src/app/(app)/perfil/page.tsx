import type { Metadata } from "next";
import { Cabecalho, Cartao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormAssinatura } from "./form";

export const metadata: Metadata = { title: "Minha assinatura" };

export default async function PerfilPage() {
  const u = await getUsuario();
  const supabase = await createClient();
  const { data: p } = await supabase.from("profiles").select("assinatura_path").eq("id", u.id).single();
  const caminho = p?.assinatura_path && p.assinatura_path.startsWith(`${u.id}/`) && !p.assinatura_path.endsWith("/removida") ? p.assinatura_path : null;
  let url: string | null = null;
  if (caminho) {
    const { data } = await supabase.storage.from("assinaturas").createSignedUrl(caminho, 600);
    url = data?.signedUrl ?? null;
  }
  return (
    <>
      <Cabecalho titulo="Minha assinatura" subtitulo={`${u.nome} · ${u.email}`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Cartao titulo="Assinatura guardada">
          {url ? (
            <div className="space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="Sua assinatura" className="max-h-40 rounded border border-slate-200 bg-white p-3" />
              <p className="text-xs text-slate-500">Esta imagem é usada quando você assina documentos. Ela não tem validade jurídica por si só: o sistema registra quem assinou, quando e o hash do arquivo.</p>
            </div>
          ) : (
            <p className="text-sm text-slate-600">Nenhuma assinatura guardada. Envie uma imagem PNG ou JPG com a sua assinatura.</p>
          )}
        </Cartao>
        <Cartao titulo={url ? "Trocar assinatura" : "Enviar assinatura"}>
          <FormAssinatura userId={u.id} />
        </Cartao>
      </div>
    </>
  );
}
