import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Campo, Cabecalho, Cartao, Dado, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { STATUS_FUNDO, STATUS_GASTO, saldoDoFundo } from "@/lib/fundos";
import { data, moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { decidirGasto, excluirGasto, fecharFundo, informarDadosBancarios, lancarGasto, recusarFechamento, solicitarFechamento } from "../actions";
import { CamposDadosBancarios } from "@/components/campos-dados-bancarios";
import { AnexosGasto, type AnexoGasto } from "./anexos";

export const metadata: Metadata = { title: "Fundo fixo" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FundoFixoPage({ params }: PageProps<"/fundos-fixos/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const u = await getUsuario();
  const supabase = await createClient();

  const { data: f } = await supabase
    .from("fundos_fixos")
    .select("id, valor, status, pessoa_id, receb_forma, receb_favorecido, receb_banco, receb_agencia, receb_conta, receb_chave_pix, receb_informado_em, fechamento_solicitado_em, fechado_em, reposicao, reembolso, saldo_repassado, pagamento_id, pagamento_inicial_id, recebimento_devolucao_id, obra:obras(id, nome), pessoa:profiles!fundos_fixos_pessoa_id_fkey(nome)")
    .eq("id", id)
    .maybeSingle();
  if (!f) notFound();

  const [{ data: gastos }, { data: meuPerfil }] = await Promise.all([
    supabase
      .from("fundo_gastos")
      .select("id, descricao, data_gasto, valor, status, motivo_recusa, anexos:fundo_gasto_anexos(id, storage_path, nome_arquivo, mime_type, assinado, created_at)")
      .eq("fundo_id", id)
      .order("data_gasto")
      .order("created_at"),
    supabase.from("profiles").select("assinatura_path").eq("id", u.id).single(),
  ]);

  const fin = u.perfil === "financeiro";
  const informados = Boolean(f.receb_informado_em);
  // Quem ainda não informou: sugere os dados do último fundo dela (só para conferir e salvar)
  const anterior =
    f.pessoa_id === u.id && !informados
      ? (
          await supabase
            .from("fundos_fixos")
            .select("receb_forma, receb_favorecido, receb_banco, receb_agencia, receb_conta, receb_chave_pix")
            .eq("pessoa_id", u.id)
            .not("receb_informado_em", "is", null)
            .order("receb_informado_em", { ascending: false })
            .limit(1)
            .maybeSingle()
        ).data
      : null;
  const dadosIniciais = { forma: (informados ? f.receb_forma : anterior?.receb_forma) ?? null, favorecido: (informados ? f.receb_favorecido : anterior?.receb_favorecido) ?? f.pessoa?.nome ?? null, banco: (informados ? f.receb_banco : anterior?.receb_banco) ?? null, agencia: (informados ? f.receb_agencia : anterior?.receb_agencia) ?? null, conta: (informados ? f.receb_conta : anterior?.receb_conta) ?? null, chavePix: (informados ? f.receb_chave_pix : anterior?.receb_chave_pix) ?? null };
  const admin = u.perfil === "administrador" || u.perfil === "administrador_master";
  const minhas = f.pessoa_id === u.id;
  const fechado = f.status === "fechado";

  const caminhoAss = meuPerfil?.assinatura_path && meuPerfil.assinatura_path.startsWith(`${u.id}/`) && !meuPerfil.assinatura_path.endsWith("/removida") ? meuPerfil.assinatura_path : null;
  const assinaturaUrl = caminhoAss && minhas ? (await supabase.storage.from("assinaturas").createSignedUrl(caminhoAss, 600)).data?.signedUrl ?? null : null;

  const aprovados = (gastos ?? []).filter((g) => g.status === "aprovado").map((g) => g.valor);
  const gastoAprovado = aprovados.reduce((s, v) => s + v, 0);
  const saldo = saldoDoFundo(f.valor, aprovados);
  const st = STATUS_FUNDO[f.status] ?? STATUS_FUNDO.em_andamento;
  const reposicaoPrevista = Math.min(gastoAprovado, f.valor);
  const reembolsoPrevisto = Math.max(gastoAprovado - f.valor, 0);

  // Saldo corrente: cada gasto aprovado desconta na ordem em que aconteceu.
  let corrente = f.valor;
  const linhas: (NonNullable<typeof gastos>[number] & { saldoApos: number })[] = [];
  for (const g of gastos ?? []) {
    if (g.status === "aprovado") corrente = Math.round((corrente - g.valor) * 100) / 100;
    linhas.push({ ...g, saldoApos: corrente });
  }

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/fundos-fixos" className="text-marca-700 hover:underline">← Fundos fixos</Link>
      </div>
      <Cabecalho
        titulo={`Fundo fixo · ${f.obra?.nome ?? ""}`}
        subtitulo={`Responsável: ${f.pessoa?.nome ?? ""}`}
        acoes={<Selo cor={st.cor}>{st.rotulo}</Selo>}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Cartao titulo="Valor do fundo"><p className="text-xl font-semibold tabular-nums">{moeda(f.valor)}</p></Cartao>
        <Cartao titulo="Gasto aprovado"><p className="text-xl font-semibold tabular-nums">{moeda(gastoAprovado)}</p></Cartao>
        <Cartao titulo="Saldo"><p className="text-xl font-semibold tabular-nums">{fechado ? "—" : moeda(Math.max(saldo, 0))}</p></Cartao>
        <Cartao titulo="Reembolso">
          <p className="text-xl font-semibold tabular-nums">{moeda(reembolsoPrevisto)}</p>
          <p className="text-xs text-slate-500">Gasto aprovado acima do valor do fundo</p>
        </Cartao>
        <Cartao titulo="Pode gastar?">
          <p className="text-sm" data-pode-gastar>
            {fechado
              ? "Fundo fechado"
              : admin
                  ? "Acompanhe e decida os gastos"
                  : minhas && !assinaturaUrl
                    ? "Só depois de cadastrar sua assinatura"
                    : minhas && !informados
                      ? "Só depois de informar seus dados bancários"
                      : "Sim: lance o gasto e assine o comprovante"}
          </p>
        </Cartao>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Cartao titulo={`Gastos (${gastos?.length ?? 0})`} semPadding>
            {!linhas.length ? (
              <Vazio>Nenhum gasto lançado.</Vazio>
            ) : (
              <ul className="divide-y divide-slate-100">
                {linhas.map((g) => {
                  const temAssinado = ((g.anexos ?? []) as AnexoGasto[]).some((a) => a.assinado);
                  const sg = g.status === "pendente" && !temAssinado ? { rotulo: "Aguardando comprovante assinado", cor: "vermelho" as const } : (STATUS_GASTO[g.status] ?? STATUS_GASTO.pendente);
                  const pendente = g.status === "pendente";
                  return (
                    <li key={g.id} className="space-y-3 px-4 py-4 sm:px-6">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{g.descricao}</div>
                          <div className="text-xs text-slate-500">{data(g.data_gasto)}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold tabular-nums">{moeda(g.valor)}</div>
                          <Selo cor={sg.cor}>{sg.rotulo}</Selo>
                        </div>
                      </div>
                      {g.status === "aprovado" && (
                        <div className="text-xs text-slate-500">Saldo após este gasto: <span className="tabular-nums">{moeda(Math.max(g.saldoApos, 0))}</span></div>
                      )}
                      {pendente && !temAssinado && (
                        <Aviso tipo="alerta">
                          Este gasto só conta no saldo depois que o comprovante for anexado <strong>e assinado</strong> por {minhas ? "você" : "quem gastou"}.
                        </Aviso>
                      )}
                      {g.status === "recusado" && (
                        <Aviso tipo="alerta">Recusado: {g.motivo_recusa}. Não entrou no saldo; lance de novo se for o caso.</Aviso>
                      )}
                      <AnexosGasto
                        gastoId={g.id}
                        fundoId={f.id}
                        anexos={(g.anexos ?? []) as AnexoGasto[]}
                        podeEnviar={minhas && !fechado}
                        podeRemover={minhas && !fechado && g.status === "pendente"}
                        assinaturaUrl={assinaturaUrl}
                      />
                      {fin && !fechado && (
                        <FormAcao action={excluirGasto.bind(null, f.id, g.id)} enviar="Excluir gasto" variante="fantasma" confirmar="Excluir este gasto? Os comprovantes deixam de estar anexados a ele." />
                      )}
                      {admin && pendente && !temAssinado && (
                        <p className="text-xs text-slate-500">A decisão fica disponível quando o comprovante assinado for anexado.</p>
                      )}
                      {admin && pendente && temAssinado && (
                        <div className="grid gap-3 rounded-md bg-amber-50 p-3 sm:grid-cols-2">
                          <FormAcao action={decidirGasto.bind(null, f.id, g.id, true)} enviar="Aprovar gasto" className="space-y-2" />
                          <FormAcao
                            action={decidirGasto.bind(null, f.id, g.id, false)}
                            enviar="Recusar gasto"
                            variante="perigo"
                            className="space-y-2"
                          >
                            <Campo rotulo="Motivo da recusa" obrigatorio>
                              <input name="motivo" required className="campo" maxLength={300} />
                            </Campo>
                          </FormAcao>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Cartao>
        </div>

        <div className="space-y-6">
          {minhas && !fechado && !f.fechamento_solicitado_em && !assinaturaUrl && (
            <Cartao titulo="Lançar gasto">
              <Aviso tipo="alerta">
                <span data-sem-assinatura>
                  Para lançar gastos você precisa ter a sua assinatura cadastrada: todo comprovante do fundo fixo é assinado por quem gastou.{" "}
                  <Link href="/perfil" className="font-medium underline">Cadastrar minha assinatura</Link>.
                </span>
              </Aviso>
            </Cartao>
          )}
          {minhas && !fechado && !f.fechamento_solicitado_em && !!assinaturaUrl && !informados && (
            <Cartao titulo="Seus dados bancários">
              <p className="mb-3 text-sm text-slate-600" data-dados-bancarios-obrigatorio>
                Antes do primeiro gasto, informe como você recebe o reembolso e a reposição deste fundo: conta bancária ou PIX.
                {anterior ? " Sugerimos os dados do seu último fundo: confira e salve." : ""}
              </p>
              <FormAcao action={informarDadosBancarios.bind(null, f.id)} enviar="Salvar dados bancários" pendente="Salvando…">
                <CamposDadosBancarios inicial={dadosIniciais} />
              </FormAcao>
            </Cartao>
          )}
          {(minhas || fin || admin) && !fechado && informados && (
            <Cartao titulo="Dados para recebimento">
              <dl className="space-y-1 text-sm" data-dados-recebimento>
                <div><dt className="inline text-slate-500">Favorecido: </dt><dd className="inline font-medium">{f.receb_favorecido}</dd></div>
                <div><dt className="inline text-slate-500">Instituição: </dt><dd className="inline font-medium">{f.receb_banco}</dd></div>
                {f.receb_forma === "pix" ? (
                  <div><dt className="inline text-slate-500">Chave PIX: </dt><dd className="inline font-medium">{f.receb_chave_pix}</dd></div>
                ) : (
                  <>
                    <div><dt className="inline text-slate-500">Agência: </dt><dd className="inline font-medium">{f.receb_agencia}</dd></div>
                    <div><dt className="inline text-slate-500">Conta: </dt><dd className="inline font-medium">{f.receb_conta}</dd></div>
                  </>
                )}
              </dl>
              {minhas && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-marca-700">Corrigir dados</summary>
                  <div className="mt-3">
                    <FormAcao action={informarDadosBancarios.bind(null, f.id)} enviar="Salvar dados bancários" pendente="Salvando…">
                      <CamposDadosBancarios inicial={dadosIniciais} />
                    </FormAcao>
                  </div>
                </details>
              )}
            </Cartao>
          )}
          {fin && !fechado && !informados && (
            <Cartao titulo="Dados para recebimento">
              <p className="text-sm text-slate-600">A pessoa ainda não informou os dados bancários. Ela informa antes do primeiro gasto; eles vão na OP e no pagamento do fechamento.</p>
            </Cartao>
          )}
          {minhas && !fechado && !f.fechamento_solicitado_em && !!assinaturaUrl && informados && (
            <Cartao titulo="Lançar gasto">
              <FormAcao action={lancarGasto.bind(null, f.id)} enviar="Lançar gasto" pendente="Lançando…">
                <Campo rotulo="Descrição" obrigatorio>
                  <input name="descricao" required className="campo" maxLength={300} placeholder="Ex.: Combustível da caminhonete" />
                </Campo>
                <div className="grid grid-cols-2 gap-3">
                  <Campo rotulo="Data" obrigatorio>
                    <input type="date" name="data_gasto" required className="campo" />
                  </Campo>
                  <Campo rotulo="Valor (R$)" obrigatorio>
                    <input name="valor" required inputMode="decimal" className="campo" placeholder="0,00" />
                  </Campo>
                </div>
              </FormAcao>
              <p className="mt-3 text-xs text-slate-500">
                O gasto só abate o saldo depois do comprovante assinado{f.obra?.id && " e, com administrador na obra, da aprovação"}. Não há limite de gastos: o que passar do valor do fundo vira reembolso quando o Financeiro fechar o fundo.
              </p>
            </Cartao>
          )}

          {minhas && !fechado && (
            <Cartao titulo="Fechar o fundo">
              {f.fechamento_solicitado_em ? (
                <p className="text-sm text-slate-600" data-fechamento-solicitado>
                  Fechamento solicitado ao Financeiro em {data(f.fechamento_solicitado_em.slice(0, 10))}. Enquanto isso você não lança novos gastos: só o Financeiro fecha o fundo (e abre um novo) ou recusa o pedido.
                </p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-slate-600">
                    Acabou a necessidade do fundo ou os gastos passaram do valor? Solicite o fechamento: o Financeiro é avisado, fecha o fundo e paga o reembolso, se houver. Depois de solicitar, você não lança novos gastos até ele fechar o fundo ou recusar o pedido.
                  </p>
                  <FormAcao action={solicitarFechamento.bind(null, f.id)} enviar="Solicitar fechamento do fundo" pendente="Solicitando…" confirmar="Solicitar ao Financeiro o fechamento deste fundo?" />
                </>
              )}
            </Cartao>
          )}

          {fin && !fechado && (
            <Cartao titulo="Fechar fundo">
              {f.fechamento_solicitado_em && (
                <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-fechamento-solicitado>
                  {f.pessoa?.nome} solicitou o fechamento deste fundo em {data(f.fechamento_solicitado_em.slice(0, 10))}: use &ldquo;Repor e continuar&rdquo; para o fundo seguir ou &ldquo;Encerrar&rdquo; se acabou. Enquanto o pedido estiver aberto, a pessoa não lança novos gastos.
                </p>
              )}
              {f.fechamento_solicitado_em && (
                <FormAcao action={recusarFechamento.bind(null, f.id)} enviar="Recusar pedido de fechamento" variante="secundario" pendente="Recusando…" className="mb-4 space-y-2 rounded-md border border-slate-200 p-3" confirmar="Recusar o pedido? A pessoa volta a poder lançar gastos.">
                  <p className="font-medium text-slate-800">Recusar o pedido</p>
                  <p className="text-sm text-slate-600">Use quando o pedido foi feito por engano ou o fundo ainda tem saldo. A pessoa é avisada e volta a lançar gastos.</p>
                  <input name="motivo" className="campo" maxLength={300} placeholder="Motivo (opcional)" aria-label="Motivo da recusa" />
                </FormAcao>
              )}
              <div className="space-y-4 text-sm text-slate-700">
                <FormAcao action={fecharFundo.bind(null, f.id)} enviar="Fechar e repor" pendente="Fechando…" className="space-y-2 rounded-md border border-slate-200 p-3" confirmar="Fechar e repor este fundo?">
                  <input type="hidden" name="modo" value="repor" />
                  <p className="font-medium text-slate-800">Repor e continuar</p>
                  <p>
                    Paga os gastos aprovados: <strong>{moeda(reposicaoPrevista + reembolsoPrevisto)}</strong>
                    {reembolsoPrevisto > 0 ? ` (reposição de ${moeda(reposicaoPrevista)} + reembolso de ${moeda(reembolsoPrevisto)})` : ""}. Um novo fundo de {moeda(f.valor)} abre na hora.
                  </p>
                  <input type="date" name="vencimento" className="campo" aria-label="Vencimento da reposição" />
                </FormAcao>
                <FormAcao action={fecharFundo.bind(null, f.id)} enviar="Encerrar fundo" variante="perigo" pendente="Encerrando…" className="space-y-2 rounded-md border border-slate-200 p-3" confirmar="Encerrar este fundo (fim da obra)?">
                  <input type="hidden" name="modo" value="encerrar" />
                  <p className="font-medium text-slate-800">Encerrar (fim da obra)</p>
                  <p>
                    {reembolsoPrevisto > 0 ? `Reembolso de ${moeda(reembolsoPrevisto)} vira um pagamento. ` : ""}
                    {saldo > 0 ? `O saldo de ${moeda(saldo)} vira uma receita em aberto (devolução à empresa).` : "Não há saldo para devolver."}
                  </p>
                  <input type="date" name="vencimento" className="campo" aria-label="Vencimento do encerramento" />
                </FormAcao>
              </div>
            </Cartao>
          )}

          {fechado && (
            <Cartao titulo="Fechamento">
              <div className="space-y-2 text-sm">
                <Dado rotulo="Fechado em">{data(f.fechado_em)}</Dado>
                <Dado rotulo="Reposição">{moeda(f.reposicao ?? 0)}</Dado>
                <Dado rotulo="Reembolso">{moeda(f.reembolso ?? 0)}</Dado>
                <Dado rotulo="Saldo devolvido à empresa">{moeda(f.saldo_repassado ?? 0)}</Dado>
                {f.pagamento_id && (
                  <Link href={`/pagamentos/${f.pagamento_id}`} className="text-marca-700 hover:underline">Ver pagamento de reposição/reembolso</Link>
                )}
                {f.recebimento_devolucao_id && (
                  <Link href={`/recebimentos/${f.recebimento_devolucao_id}`} className="block text-marca-700 hover:underline">Ver devolução do saldo (Contas a receber)</Link>
                )}
              </div>
            </Cartao>
          )}
        </div>
      </div>
    </>
  );
}
