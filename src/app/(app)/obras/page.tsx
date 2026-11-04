import type { Metadata } from "next";
import Link from "next/link";
import { Cabecalho, Cartao, LinkBotao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { STATUS_OBRA } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Obras" };

export default async function ObrasPage() {
  const u = await getUsuario();
  const supabase = await createClient();
  const [{ data: obras }, { data: acessos }] = await Promise.all([
    supabase
      .from("obras")
      .select(
        "id, codigo, nome, cidade, uf, fluxo, status, engenheiro:profiles!obras_engenheiro_id_fkey(nome), administrador:profiles!obras_administrador_id_fkey(nome)",
      )
      .order("status")
      .order("nome"),
    u.perfil === "suprimentos" ? supabase.from("obra_acessos").select("obra_id").eq("user_id", u.id) : Promise.resolve({ data: [] }),
  ]);
  const liberadas = new Set((acessos ?? []).map((a) => a.obra_id));

  return (
    <>
      <Cabecalho
        titulo="Obras"
        subtitulo={u.perfil === "engenheiro" || u.perfil === "administrador" ? "Obras às quais você está vinculado" : undefined}
        acoes={u.perfil === "financeiro" && <LinkBotao href="/obras/nova">+ Nova obra</LinkBotao>}
      />
      <Cartao semPadding>
        {!obras?.length ? (
          <Vazio>Nenhuma obra disponível.</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Obra</th>
                  <th>Local</th>
                  <th>Fluxo</th>
                  <th>Engenheiro</th>
                  <th>Administrador</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {obras.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/obras/${o.id}`} className="font-medium text-marca-700 hover:underline">
                        {o.nome}
                      </Link>
                      {o.codigo && <div className="text-xs text-slate-500">{o.codigo}</div>}
                      {u.perfil === "suprimentos" && liberadas.has(o.id) && (
                        <div className="mt-0.5">
                          <Selo cor="verde">Você pode atuar</Selo>
                        </div>
                      )}
                    </td>
                    <td>
                      {o.cidade}/{o.uf}
                    </td>
                    <td>
                      <Selo cor="roxo">Fluxo {o.fluxo}</Selo>
                    </td>
                    <td>{o.engenheiro?.nome ?? "—"}</td>
                    <td>{o.administrador?.nome ?? "—"}</td>
                    <td>
                      <Selo cor={o.status === "ativa" ? "verde" : "cinza"}>{STATUS_OBRA[o.status]}</Selo>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </>
  );
}
