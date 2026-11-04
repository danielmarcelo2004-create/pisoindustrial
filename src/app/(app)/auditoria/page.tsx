import type { Metadata } from "next";
import Link from "next/link";
import { Alteracoes } from "@/components/linha-do-tempo";
import { Cabecalho, Cartao, Vazio, classeBotao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { dataHora } from "@/lib/formato";
import { PERFIS } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Histórico de atividades" };

const ENTIDADES: Record<string, string> = {
  pagamento: "Pagamentos",
  documento: "Documentos",
  obras: "Obras",
  obra_acessos: "Acessos a obras",
  fornecedores: "Fornecedores",
  profiles: "Usuários",
};
const POR_PAGINA = 100;

export default async function AuditoriaPage({ searchParams }: PageProps<"/auditoria">) {
  await exigirPerfil("financeiro");
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const pagina = Math.max(1, Number(s("pagina")) || 1);
  const supabase = await createClient();

  let q = supabase.from("auditoria").select("*", { count: "exact" }).order("id", { ascending: false });
  if (s("entidade") && ENTIDADES[s("entidade")]) q = q.eq("entidade", s("entidade"));
  if (/^[0-9a-f-]{36}$/i.test(s("usuario"))) q = q.eq("user_id", s("usuario"));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s("de"))) q = q.gte("created_at", `${s("de")}T00:00:00-03:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s("ate"))) q = q.lte("created_at", `${s("ate")}T23:59:59.999-03:00`);
  q = q.range((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA - 1);

  const [{ data: eventos, count }, { data: usuarios }, { data: obras }] = await Promise.all([
    q,
    supabase.from("profiles").select("id, nome").order("nome"),
    supabase.from("obras").select("id, nome"),
  ]);
  const nomes = Object.fromEntries([...(usuarios ?? []), ...(obras ?? [])].map((x) => [x.id, x.nome]));
  const total = count ?? 0;
  const qs = (n: number) => {
    const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][]);
    p.set("pagina", String(n));
    return `/auditoria?${p}`;
  };

  return (
    <>
      <Cabecalho
        titulo="Histórico de atividades"
        subtitulo="Registro imutável de todas as ações: ninguém pode editar ou apagar estes registros."
      />
      <Cartao className="mb-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <select name="entidade" defaultValue={s("entidade")} className="campo">
            <option value="">Todos os registros</option>
            {Object.entries(ENTIDADES).map(([v, r]) => (
              <option key={v} value={v}>
                {r}
              </option>
            ))}
          </select>
          <select name="usuario" defaultValue={s("usuario")} className="campo">
            <option value="">Todos os usuários</option>
            {(usuarios ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.nome}
              </option>
            ))}
          </select>
          <input type="date" name="de" defaultValue={s("de")} className="campo" aria-label="De" />
          <input type="date" name="ate" defaultValue={s("ate")} className="campo" aria-label="Até" />
          <div className="flex gap-2">
            <button className={classeBotao("primario", "sm")}>Filtrar</button>
            <Link href="/auditoria" className={classeBotao("fantasma", "sm")}>
              Limpar
            </Link>
          </div>
        </form>
      </Cartao>
      <Cartao semPadding>
        {!eventos?.length ? (
          <Vazio>Nenhum registro.</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Data/hora</th>
                  <th>Usuário</th>
                  <th>Ação</th>
                  <th>Referência</th>
                </tr>
              </thead>
              <tbody>
                {eventos.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap tabular-nums">{dataHora(e.created_at)}</td>
                    <td className="whitespace-nowrap">
                      {e.user_nome ?? "Sistema"}
                      {e.user_perfil && <div className="text-xs text-slate-500">{PERFIS[e.user_perfil]}</div>}
                    </td>
                    <td className="min-w-72">
                      {e.descricao ?? e.acao}
                      {e.acao === "alterou" && <Alteracoes antes={e.dados_antes} depois={e.dados_depois} nomes={nomes} />}
                    </td>
                    <td className="text-xs whitespace-nowrap">
                      {e.pagamento_id ? (
                        <Link href={`/pagamentos/${e.pagamento_id}`} className="text-marca-700 hover:underline">
                          Ver pagamento
                        </Link>
                      ) : e.entidade === "profiles" && e.entidade_id ? (
                        <Link href={`/usuarios/${e.entidade_id}`} className="text-marca-700 hover:underline">
                          {nomes[e.entidade_id] ?? "Usuário"}
                        </Link>
                      ) : e.obra_id ? (
                        <Link href={`/obras/${e.obra_id}`} className="text-marca-700 hover:underline">
                          {nomes[e.obra_id] ?? "Obra"}
                          {e.entidade === "obra_acessos" && e.entidade_id && ` · ${nomes[e.entidade_id] ?? ""}`}
                        </Link>
                      ) : e.entidade === "fornecedores" && e.entidade_id ? (
                        <Link href={`/fornecedores/${e.entidade_id}`} className="text-marca-700 hover:underline">
                          Fornecedor
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > POR_PAGINA && (
          <div className="flex justify-end gap-3 px-4 py-3 text-sm">
            {pagina > 1 && <Link href={qs(pagina - 1)}>← Anterior</Link>}
            <span>
              Página {pagina} de {Math.ceil(total / POR_PAGINA)}
            </span>
            {pagina * POR_PAGINA < total && <Link href={qs(pagina + 1)}>Próxima →</Link>}
          </div>
        )}
      </Cartao>
    </>
  );
}
