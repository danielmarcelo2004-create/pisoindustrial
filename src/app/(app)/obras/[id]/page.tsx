import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Aviso, Cabecalho, Campo, Cartao, Dado, LinkBotao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { listarPagamentos } from "@/lib/consultas/pagamentos";
import { responsaveisAtivos } from "@/lib/consultas/usuarios";
import { FLUXOS, PERFIS, STATUS_OBRA } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { CamposObra } from "../campos";
import { concederAcesso, revogarAcesso, salvarObra } from "../actions";

export const metadata: Metadata = { title: "Centro de custo" };

export default async function ObraPage({ params, searchParams }: PageProps<"/obras/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const u = await getUsuario();
  const fin = u.perfil === "financeiro";
  const supabase = await createClient();

  const { data: o } = await supabase
    .from("obras")
    .select("*, engenheiro:profiles!obras_engenheiro_id_fkey(nome), administrador:profiles!obras_administrador_id_fkey(nome)")
    .eq("id", id)
    .maybeSingle();
  if (!o) notFound();

  const [{ data: acessos }, pagamentos, resp, { data: usuarios }, { data: podeAtuar }] = await Promise.all([
    supabase.from("obra_acessos").select("user_id, created_at, usuario:profiles!obra_acessos_user_id_fkey(nome, perfil, ativo)").eq("obra_id", id),
    listarPagamentos({ obra: id, status: "abertos" }, 1, 100),
    fin ? responsaveisAtivos() : Promise.resolve(null),
    fin
      ? supabase.from("profiles").select("id, nome, perfil").eq("ativo", true).neq("perfil", "financeiro").order("nome")
      : Promise.resolve({ data: [] }),
    supabase.rpc("pode_atuar_obra", { p_obra_id: id }),
  ]);
  const comAcesso = new Set((acessos ?? []).map((a) => a.user_id));

  return (
    <>
      <Cabecalho
        voltar={{ href: "/obras", rotulo: "Centros de custo" }}
        titulo={
          <span className="flex flex-wrap items-center gap-3">
            {o.nome}
            <Selo cor={o.status === "ativa" ? "verde" : "cinza"}>{STATUS_OBRA[o.status]}</Selo>
          </span>
        }
        subtitulo={`${o.codigo ? o.codigo + " · " : ""}${o.cidade}/${o.uf}`}
        acoes={
          <>
            <LinkBotao href={`/pagamentos?obra=${id}`} variante="secundario">
              Todos os pagamentos
            </LinkBotao>
            {podeAtuar && o.status === "ativa" && <LinkBotao href={`/pagamentos/novo?obra=${id}`}>+ Novo pagamento</LinkBotao>}
          </>
        }
      />
      {sp.criada && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Centro de custo cadastrado. Conceda abaixo os acessos de Suprimentos, se necessário.</Aviso>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {fin && resp ? (
            <Cartao titulo="Dados da obra e fluxo de aprovação">
              <FormAcao action={salvarObra.bind(null, id)} enviar="Salvar alterações">
                <CamposObra engenheiros={resp.engenheiros} administradores={resp.administradores} padrao={o} />
                <Aviso tipo="info">
                  Ao mudar o fluxo ou os responsáveis, os pagamentos pendentes são reencaminhados automaticamente e a mudança fica
                  registrada no histórico.
                </Aviso>
              </FormAcao>
            </Cartao>
          ) : (
            <Cartao titulo="Dados do centro de custo">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Dado rotulo="Cliente">{o.cliente}</Dado>
                <Dado rotulo="Endereço">{o.endereco}</Dado>
                <Dado rotulo="Engenheiro responsável">{o.engenheiro?.nome}</Dado>
                <Dado rotulo="Administrador responsável">{o.administrador?.nome}</Dado>
                <div className="sm:col-span-2">
                  <Dado rotulo="Fluxo de aprovação">
                    {FLUXOS[o.fluxo].rotulo}
                    <div className="text-xs text-slate-500">{FLUXOS[o.fluxo].descricao}</div>
                  </Dado>
                </div>
              </dl>
            </Cartao>
          )}

          <Cartao titulo={`Pagamentos em aberto (${pagamentos.total})`} semPadding>
            <TabelaPagamentos itens={pagamentos.itens} semObra vazio="Nenhum pagamento em aberto nesta obra." />
          </Cartao>
        </div>

        <div className="min-w-0 space-y-6">
          <Cartao titulo="Acessos ao centro de custo">
            <p className="mb-3 text-xs text-slate-500">
              O engenheiro e o administrador responsáveis já têm acesso. Conceda aqui o acesso de Suprimentos (para cadastrar
              pagamentos) ou de outros engenheiros/administradores.
            </p>
            {acessos && acessos.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {acessos.map((a) => (
                  <li key={a.user_id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      {a.usuario?.nome}
                      <span className="block text-xs text-slate-500">
                        {a.usuario && PERFIS[a.usuario.perfil]}
                        {a.usuario && !a.usuario.ativo && " · inativo"}
                      </span>
                    </span>
                    {fin && (
                      <FormAcao
                        action={revogarAcesso.bind(null, id, a.user_id)}
                        enviar="Revogar"
                        variante="fantasma"
                        className="flex items-center"
                        confirmar={`Revogar o acesso de ${a.usuario?.nome}?`}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Vazio>Nenhum acesso adicional.</Vazio>
            )}
            {fin && (
              <div className="mt-3 border-t border-slate-200 pt-3">
                <FormAcao action={concederAcesso.bind(null, id)} enviar="Conceder acesso" variante="secundario">
                  <Campo rotulo="Usuário">
                    <select name="user_id" required className="campo" defaultValue="">
                      <option value="">Selecione…</option>
                      {(usuarios ?? [])
                        .filter((x) => !comAcesso.has(x.id))
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.nome} — {PERFIS[x.perfil]}
                          </option>
                        ))}
                    </select>
                  </Campo>
                </FormAcao>
              </div>
            )}
          </Cartao>
        </div>
      </div>
    </>
  );
}
