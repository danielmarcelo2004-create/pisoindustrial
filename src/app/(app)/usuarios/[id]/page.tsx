import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AcaoCredenciais } from "@/components/credenciais";
import { FormAcao } from "@/components/form-acao";
import { LinhaDoTempo } from "@/components/linha-do-tempo";
import { Cabecalho, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { PERFIS } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { atualizarUsuario, redefinirSenha, salvarAcessos } from "../actions";

export const metadata: Metadata = { title: "Usuário" };

export default async function UsuarioPage({ params }: PageProps<"/usuarios/[id]">) {
  const eu = await exigirPerfil("financeiro");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: p } = await supabase.from("profiles").select("*").eq("id", id).maybeSingle();
  if (!p) notFound();

  const [{ data: obras }, { data: acessos }, { data: eventos }] = await Promise.all([
    supabase.from("obras").select("id, nome, status, engenheiro_id, administrador_id").order("nome"),
    supabase.from("obra_acessos").select("obra_id").eq("user_id", id),
    supabase.from("auditoria").select("*").eq("entidade", "profiles").eq("entidade_id", id).order("id", { ascending: false }).limit(30),
  ]);
  const tem = new Set((acessos ?? []).map((a) => a.obra_id));
  const responsavel = (obras ?? []).filter((o) => o.engenheiro_id === id || o.administrador_id === id);
  const proprio = eu.id === id;

  return (
    <>
      <Cabecalho
        voltar={{ href: "/usuarios", rotulo: "Usuários" }}
        titulo={
          <span className="flex items-center gap-3">
            {p.nome} {p.ativo ? <Selo cor="verde">Ativo</Selo> : <Selo>Inativo</Selo>}
          </span>
        }
        subtitulo={`${p.email} · ${PERFIS[p.perfil]}`}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Cartao titulo="Cadastro">
            <FormAcao action={atualizarUsuario.bind(null, id)} enviar="Salvar">
              <div className="grid gap-4 sm:grid-cols-2">
                <Campo rotulo="Nome" obrigatorio>
                  <input name="nome" required defaultValue={p.nome} className="campo" />
                </Campo>
                <Campo rotulo="E-mail (login)">
                  <input value={p.email} disabled className="campo" readOnly />
                </Campo>
                <Campo rotulo="Telefone / WhatsApp">
                  <input name="telefone" defaultValue={p.telefone ?? ""} className="campo" />
                </Campo>
                <Campo rotulo="Perfil">
                  <select name="perfil" defaultValue={p.perfil} className="campo" disabled={proprio}>
                    {Object.entries(PERFIS).map(([v, r]) => (
                      <option key={v} value={v}>
                        {r}
                      </option>
                    ))}
                  </select>
                  {proprio && <input type="hidden" name="perfil" value={p.perfil} />}
                </Campo>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="ativo" defaultChecked={p.ativo} disabled={proprio} />
                {proprio && <input type="hidden" name="ativo" value="on" />}
                Acesso ativo {proprio && <span className="text-xs text-slate-500">(você não pode desativar o próprio acesso)</span>}
              </label>
            </FormAcao>
          </Cartao>

          {p.perfil !== "financeiro" && (
            <Cartao titulo="Acesso às obras">
              {responsavel.length > 0 && (
                <div className="mb-4 text-sm">
                  <div className="mb-1 font-medium text-slate-700">Responsável por:</div>
                  <ul className="list-inside list-disc text-slate-600">
                    {responsavel.map((o) => (
                      <li key={o.id}>
                        <Link href={`/obras/${o.id}`} className="hover:underline">
                          {o.nome}
                        </Link>{" "}
                        ({o.engenheiro_id === id ? "engenheiro" : "administrador"})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <FormAcao action={salvarAcessos.bind(null, id)} enviar="Salvar acessos">
                <p className="text-xs text-slate-500">
                  {p.perfil === "suprimentos"
                    ? "Suprimentos visualiza todas as obras, mas só cadastra e altera pagamentos nas obras marcadas."
                    : "Vínculos adicionais (além das obras em que é responsável)."}
                </p>
                {obras?.length ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {obras.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="obras" value={o.id} defaultChecked={tem.has(o.id)} />
                        {o.nome}
                        {o.status !== "ativa" && <span className="text-xs text-slate-400">({o.status})</span>}
                      </label>
                    ))}
                  </div>
                ) : (
                  <Vazio>Nenhuma obra cadastrada.</Vazio>
                )}
              </FormAcao>
            </Cartao>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {!proprio && (
            <Cartao titulo="Senha">
              <p className="mb-3 text-sm text-slate-600">
                Gera uma nova senha provisória. O usuário terá de criar uma senha própria no próximo acesso.
              </p>
              <AcaoCredenciais
                action={redefinirSenha.bind(null, id)}
                rotulo="Gerar nova senha provisória"
                confirmar={`Gerar nova senha provisória para ${p.nome}? A senha atual deixará de funcionar.`}
              />
            </Cartao>
          )}
          <Cartao titulo="Histórico do cadastro">
            {eventos?.length ? <LinhaDoTempo eventos={eventos} /> : <Vazio>Sem registros.</Vazio>}
          </Cartao>
        </div>
      </div>
    </>
  );
}
