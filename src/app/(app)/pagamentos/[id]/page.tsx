import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { removerNF } from "@/app/(app)/compras/actions";
import { FormDecisao } from "@/components/assinatura";
import { AssinadorDocumentos } from "./assinador";
import { FormParcelas } from "./parcelas";
import { definirParcelas, registrarBaixaParcela } from "../actions";
import { FormAcao } from "@/components/form-acao";
import { LinhaDoTempo } from "@/components/linha-do-tempo";
import { SeloStatus, Vencimento } from "@/components/pagamentos";
import { Aviso, Cabecalho, Campo, Cartao, Dado, LinkBotao, Selo, Vazio, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { cpfCnpj, data, dataHora, hojeISO, moeda, tamanhoArquivo, valorParaCampo } from "@/lib/formato";
import { FLUXOS, FORMAS_PAGAMENTO, PERFIS, TIPOS_DOCUMENTO, type StatusPagamento } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import {
  anexarDocumento,
  cancelarPagamento,
  reenviarPagamento,
  registrarBaixa,
  substituirDocumento,
} from "../actions";

export const metadata: Metadata = { title: "Pagamento" };

const ACEITOS = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.xml";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Etapa = { chave: string; rotulo: string; quem?: string | null };

function etapas(fluxo: "A" | "B" | "C", eng?: string | null, adm?: string | null): Etapa[] {
  return [
    { chave: "cadastro", rotulo: "Cadastro" },
    ...(fluxo === "A" ? [{ chave: "aguardando_engenheiro", rotulo: "Engenheiro", quem: eng }] : []),
    ...(fluxo !== "C" ? [{ chave: "aguardando_administrador", rotulo: "Administrador", quem: adm }] : []),
    { chave: "aguardando_pagamento", rotulo: "Financeiro" },
    { chave: "pago", rotulo: "Pago" },
  ];
}

function Etapas({ lista, status }: { lista: Etapa[]; status: StatusPagamento }) {
  const atual = status === "rejeitado" || status === "cancelado" ? -1 : lista.findIndex((e) => e.chave === status);
  return (
    <ol className="flex flex-wrap items-center gap-y-2 text-xs">
      {lista.map((e, i) => {
        const feito = atual === -1 ? false : i < atual || status === "pago";
        const corrente = i === atual && status !== "pago";
        return (
          <li key={e.chave} className="flex items-center">
            <span
              className={cx(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
                feito && "bg-emerald-50 text-emerald-800",
                corrente && "bg-amber-100 text-amber-900 ring-1 ring-amber-400",
                !feito && !corrente && "bg-slate-100 text-slate-500",
              )}
            >
              {feito ? "✓" : i + 1} {e.rotulo}
              {e.quem && <span className="font-normal opacity-75">· {e.quem}</span>}
            </span>
            {i < lista.length - 1 && <span className="mx-1 text-slate-300">—</span>}
          </li>
        );
      })}
    </ol>
  );
}

export default async function PagamentoPage({ params, searchParams }: PageProps<"/pagamentos/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const u = await getUsuario();
  const supabase = await createClient();

  const { data: p } = await supabase
    .from("pagamentos")
    .select(
      `*, obra:obras(id, nome, cidade, uf, fluxo, engenheiro_id, administrador_id,
        engenheiro:profiles!obras_engenheiro_id_fkey(nome), administrador:profiles!obras_administrador_id_fkey(nome)),
       fornecedor:fornecedores(id, nome, cpf_cnpj, chave_pix, banco, agencia, conta),
       criador:profiles!pagamentos_created_by_fkey(nome),
       pagador:profiles!pagamentos_pago_por_fkey(nome)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (!p || !p.obra) notFound();

  const [{ data: docs }, { data: assinaturas }, { data: eventos }, { data: podeAtuar }, { data: perfis }] = await Promise.all([
    supabase
      .from("documentos")
      .select("*, enviado:profiles!documentos_enviado_por_fkey(nome)")
      .eq("pagamento_id", id)
      .order("created_at"),
    supabase.from("assinaturas").select("*").eq("pagamento_id", id).order("created_at"),
    supabase.from("auditoria").select("*").eq("pagamento_id", id).order("id"),
    supabase.rpc("pode_atuar_obra", { p_obra_id: p.obra_id }),
    supabase.from("profiles").select("id, nome"),
  ]);
  // OP aberta pelo administrador responsável passa a "em análise".
  if (p.ordem_id && p.status === "aguardando_administrador" && p.obra.administrador_id === u.id) {
    await supabase.rpc("marcar_op_em_analise", { p_pagamento_id: id });
  }
  const nomes = Object.fromEntries((perfis ?? []).map((x) => [x.id, x.nome]));

  const ativos = (docs ?? []).filter((d) => d.ativo);
  const analista = u.perfil === "financeiro" || u.perfil === "suprimentos";
  const { data: parcelas } = await supabase.from("pagamento_parcelas").select("*").eq("pagamento_id", id).order("numero");
  const podeParcelar = p.created_by === u.id && (u.perfil === "financeiro" || u.perfil === "suprimentos") && !["pago", "cancelado", "rejeitado"].includes(p.status);

  // Assinatura guardada do usuário (para assinar os documentos deste pagamento)
  const { data: meuPerfil } = await supabase.from("profiles").select("assinatura_path").eq("id", u.id).single();
  const caminhoAss = meuPerfil?.assinatura_path && meuPerfil.assinatura_path.startsWith(`${u.id}/`) && !meuPerfil.assinatura_path.endsWith("/removida") ? meuPerfil.assinatura_path : null;
  const assinaturaUrl = caminhoAss ? (await supabase.storage.from("assinaturas").createSignedUrl(caminhoAss, 600)).data?.signedUrl ?? null : null;
  const assinaturaMime = caminhoAss?.endsWith(".png") ? ("image/png" as const) : ("image/jpeg" as const);
  const idsNF = ativos.filter((d) => d.tipo === "nota_fiscal").map((d) => d.id);
  const { data: notasNF } =
    analista && idsNF.length
      ? await supabase.from("nf_notas").select("id, documento_id, origem, nf_itens(count)").in("documento_id", idsNF)
      : { data: [] as { id: string; documento_id: string; origem: string; nf_itens: { count: number }[] }[] };
  const notaPorDoc = new Map((notasNF ?? []).map((n) => [n.documento_id, n]));
  const historico = (docs ?? []).filter((d) => !d.ativo);
  const finalizado = p.status === "pago" || p.status === "cancelado";
  const souAssinante =
    (p.status === "aguardando_engenheiro" && p.obra.engenheiro_id === u.id) ||
    (p.status === "aguardando_administrador" && p.obra.administrador_id === u.id);
  // Baixa e comprovante: Financeiro e Administrador master (todas as obras).
  const baixa = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const atua = Boolean(podeAtuar) && !finalizado;

  return (
    <>
      <Cabecalho
        voltar={
          u.perfil === "engenheiro" || u.perfil === "administrador" || u.perfil === "administrador_master"
            ? { href: "/aprovacoes", rotulo: "Aprovações e assinaturas" }
            : { href: "/pagamentos", rotulo: "Pagamentos" }
        }
        titulo={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              Pagamento nº {p.numero}
              <span className="ml-2 text-base font-normal text-slate-500">versão {p.versao}</span>
            </span>
            <SeloStatus status={p.status} />
          </span>
        }
        subtitulo={
          <>
            {p.favorecido} · {p.obra.nome}
          </>
        }
        acoes={
          <>
            {p.ordem_id && (
              <LinkBotao href={`/ops/${p.ordem_id}`} variante="secundario">
                Ver solicitação {p.numero_documento}
              </LinkBotao>
            )}
            {(atua || (Boolean(podeAtuar) && p.status !== "cancelado" && (u.perfil === "financeiro" || u.perfil === "suprimentos"))) && (
              <LinkBotao href={`/pagamentos/${id}/editar`} variante="secundario">
                Editar dados
              </LinkBotao>
            )}
          </>
        }
      />

      <div className="space-y-3">
        {sp.criado && <Aviso tipo="sucesso">Pagamento cadastrado e encaminhado conforme o fluxo da obra.</Aviso>}
        {sp.decisao === "aprovado" && <Aviso tipo="sucesso">Documento assinado e encaminhado para a próxima etapa.</Aviso>}
        {sp.decisao === "rejeitado" && <Aviso tipo="sucesso">Rejeição registrada. Quem cadastrou e o Financeiro foram notificados.</Aviso>}
        {sp.nf === "lancada" && <Aviso tipo="sucesso">Itens da nota registrados na Inteligência de Compras.</Aviso>}
        {sp.salvo && <Aviso tipo="sucesso">Alterações salvas e registradas no histórico.</Aviso>}
        {typeof sp.aviso === "string" && <Aviso tipo="alerta">Pagamento criado, mas houve problema com anexos: {sp.aviso}</Aviso>}
        {p.status === "rejeitado" && (
          <Aviso tipo="erro">
            <strong>Rejeitado.</strong> Motivo: {p.rejeicao_motivo}
          </Aviso>
        )}
        {p.status === "cancelado" && (
          <Aviso tipo="alerta">
            <strong>Cancelado.</strong> Motivo: {p.cancelamento_motivo}
          </Aviso>
        )}
      </div>

      <div className="mt-4 mb-6 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <Etapas lista={etapas(p.fluxo, p.obra.engenheiro?.nome, p.obra.administrador?.nome)} status={p.status} />
        <p className="mt-2 text-xs text-slate-500">{FLUXOS[p.fluxo].rotulo}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Cartao titulo="Dados do pagamento">
            <dl className="grid gap-4 sm:grid-cols-3">
              <Dado rotulo="Valor">
                <span className="text-lg font-semibold tabular-nums">{moeda(p.valor)}</span>
              </Dado>
              <Dado rotulo="Vencimento">
                <Vencimento iso={p.vencimento} status={p.status} />
              </Dado>
              <Dado rotulo="Forma de pagamento">{FORMAS_PAGAMENTO[p.forma_pagamento]}</Dado>
              <Dado rotulo="Favorecido">{p.favorecido}</Dado>
              <Dado rotulo="Fornecedor">
                {p.fornecedor ? (
                  <>
                    {p.fornecedor.nome}
                    {p.fornecedor.cpf_cnpj && <div className="text-xs text-slate-500">{cpfCnpj(p.fornecedor.cpf_cnpj)}</div>}
                  </>
                ) : (
                  "—"
                )}
              </Dado>
              <Dado rotulo="Nº documento / NF">{p.numero_documento ?? "—"}</Dado>
              <div className="sm:col-span-3">
                <Dado rotulo="Descrição">{p.descricao}</Dado>
              </div>
              {p.observacoes && (
                <div className="sm:col-span-3">
                  <Dado rotulo="Observações">
                    <span className="whitespace-pre-line">{p.observacoes}</span>
                  </Dado>
                </div>
              )}
              <Dado rotulo="Centro de custo">
                {p.obra.nome}
                <div className="text-xs text-slate-500">
                  {p.obra.cidade}/{p.obra.uf}
                </div>
              </Dado>
              <Dado rotulo="Cadastrado por">
                {p.criador?.nome}
                <div className="text-xs text-slate-500">{dataHora(p.created_at)}</div>
              </Dado>
              {p.status === "pago" && (
                <Dado rotulo="Pagamento efetuado">
                  {data(p.pago_em)} · {moeda(p.valor_pago)}
                  <div className="text-xs text-slate-500">por {p.pagador?.nome}</div>
                </Dado>
              )}
              {baixa && p.fornecedor && (p.fornecedor.chave_pix || p.fornecedor.banco) && (
                <div className="sm:col-span-3">
                  <Dado rotulo="Dados bancários do fornecedor">
                    {p.fornecedor.chave_pix && <div>PIX: {p.fornecedor.chave_pix}</div>}
                    {p.fornecedor.banco && (
                      <div>
                        {p.fornecedor.banco} · Ag. {p.fornecedor.agencia} · CC {p.fornecedor.conta}
                      </div>
                    )}
                  </Dado>
                </div>
              )}
            </dl>
          </Cartao>

          <Cartao titulo={`Documentos (${ativos.length})`} semPadding>
            {ativos.length === 0 ? (
              <Vazio>Nenhum documento anexado.</Vazio>
            ) : (
              <ul className="divide-y divide-slate-100">
                {ativos.map((d) => (
                  <li key={d.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <a href={`/documentos/${d.id}`} target="_blank" rel="noopener" className="font-medium break-all text-marca-700 hover:underline">
                          {d.nome_arquivo}
                        </a>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <Selo cor={d.tipo === "comprovante" ? "verde" : "cinza"}>{TIPOS_DOCUMENTO[d.tipo]}</Selo>
                          {d.versao > 1 && <Selo cor="roxo">versão {d.versao}</Selo>}
                          <span>{tamanhoArquivo(d.tamanho)}</span>
                          <span>
                            · {d.enviado?.nome} · {dataHora(d.created_at)}
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-slate-400" title="SHA-256 do arquivo">
                          SHA-256 {d.sha256.slice(0, 16)}…
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <a href={`/documentos/${d.id}?baixar=1`} className="text-xs text-slate-600 hover:underline">
                          Baixar
                        </a>
                      </div>
                    </div>
                    {analista && d.tipo === "nota_fiscal" && (
                      <div className="mt-1.5 text-xs">
                        {notaPorDoc.get(d.id) ? (
                          <span className="text-emerald-700">
                            ✓ {notaPorDoc.get(d.id)!.nf_itens[0]?.count ?? 0} item(ns) na Inteligência de Compras (
                            {notaPorDoc.get(d.id)!.origem === "xml" ? "lidos do XML" : "lançamento manual"})
                            {notaPorDoc.get(d.id)!.origem === "manual" && (podeAtuar || baixa) && (
                              <FormAcao
                                action={removerNF.bind(null, notaPorDoc.get(d.id)!.id, id)}
                                enviar="Remover para relançar"
                                variante="fantasma"
                                className="ml-2 inline-flex"
                                confirmar="Remover os itens lançados desta nota?"
                              />
                            )}
                          </span>
                        ) : (podeAtuar || baixa) ? (
                          <Link href={`/compras/lancar/${d.id}`} className="text-marca-700 hover:underline">
                            Lançar itens desta nota na Inteligência de Compras →
                          </Link>
                        ) : null}
                      </div>
                    )}
                    {atua && d.tipo !== "comprovante" && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-amber-700 hover:underline">Substituir por nova versão</summary>
                        <div className="mt-2 rounded-md bg-slate-50 p-3">
                          <FormAcao action={substituirDocumento.bind(null, id, d.id)} enviar="Substituir" variante="secundario" limparAoConcluir>
                            <Campo rotulo="Novo arquivo" obrigatorio>
                              <input type="file" name="arquivo" accept={ACEITOS} required className="campo" />
                            </Campo>
                            <Campo rotulo="Motivo da substituição" obrigatorio>
                              <input name="motivo" required className="campo" />
                            </Campo>
                            {assinaturas?.some((a) => a.decisao === "aprovado" && a.pagamento_versao === p.versao) && (
                              <Aviso tipo="alerta">Este pagamento já tem assinatura nesta versão: a substituição reinicia o fluxo de assinaturas.</Aviso>
                            )}
                          </FormAcao>
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {historico.length > 0 && (
              <details className="border-t border-slate-200 px-4 py-3">
                <summary className="cursor-pointer text-sm text-slate-600">Versões anteriores ({historico.length})</summary>
                <ul className="mt-2 space-y-2">
                  {historico.map((d) => (
                    <li key={d.id} className="text-xs text-slate-600">
                      <a href={`/documentos/${d.id}`} target="_blank" rel="noopener" className="text-marca-700 line-through hover:underline">
                        {d.nome_arquivo}
                      </a>{" "}
                      · {TIPOS_DOCUMENTO[d.tipo]} v{d.versao} · enviado por {d.enviado?.nome} em {dataHora(d.created_at)}
                      <div className="text-slate-500">
                        Substituído em {dataHora(d.substituido_em)} — motivo: {d.motivo_substituicao}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {(atua || (baixa && (p.status === "pago" || p.status === "aguardando_pagamento"))) && (
              <div className="border-t border-slate-200 px-4 py-3">
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-marca-700">+ Anexar documento</summary>
                  <div className="mt-3">
                    <FormAcao action={anexarDocumento.bind(null, id)} enviar="Anexar" limparAoConcluir>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Campo rotulo="Tipo" obrigatorio>
                          <select name="tipo" required className="campo" defaultValue={atua ? "" : "comprovante"}>
                            {atua && <option value="">Selecione…</option>}
                            {Object.entries(TIPOS_DOCUMENTO)
                              .filter(([t]) => (t === "comprovante" ? baixa : atua))
                              .map(([v, r]) => (
                                <option key={v} value={v}>
                                  {r}
                                </option>
                              ))}
                          </select>
                        </Campo>
                        <Campo rotulo="Arquivo(s)" obrigatorio>
                          <input type="file" name="arquivo" accept={ACEITOS} multiple required className="campo" />
                        </Campo>
                      </div>
                    </FormAcao>
                  </div>
                </details>
              </div>
            )}
          </Cartao>

          <Cartao titulo="Linha do tempo">
            {eventos && eventos.length > 0 ? <LinhaDoTempo eventos={eventos} nomes={nomes} /> : <Vazio>Sem registros.</Vazio>}
          </Cartao>
        </div>

        <div className="min-w-0 space-y-6">
          {souAssinante &&
            !ativos.some((d) => d.tipo === "documento_assinado" && d.enviado_por === u.id && d.pagamento_versao === p.versao) &&
            ativos.some((d) => d.tipo !== "comprovante" && d.tipo !== "documento_assinado" && ["application/pdf", "image/png", "image/jpeg"].includes(d.mime_type ?? "")) && (
              <Aviso tipo="alerta">
                Antes de assinar e aprovar, posicione sua assinatura no documento (botão “Abrir e posicionar a assinatura”, abaixo).
                A aprovação só é aceita depois disso.
              </Aviso>
            )}
          {souAssinante && (
            <Cartao titulo="Sua assinatura" className="border-amber-300 ring-2 ring-amber-100">
              <p className="mb-3 text-sm text-slate-600">
                Este pagamento aguarda sua conferência como <strong>{PERFIS[u.perfil]}</strong>. Abra os documentos ao lado antes
                de decidir.
              </p>
              <FormDecisao
                retorno={`/pagamentos/${id}`}
                itens={[
                  {
                    id: p.id,
                    numero: p.numero,
                    versao: p.versao,
                    favorecido: p.favorecido,
                    descricao: p.descricao,
                    valor: Number(p.valor),
                    vencimento: p.vencimento,
                    obra: p.obra.nome,
                    etapa: "",
                    documentos: ativos.length,
                  },
                ]}
              />
            </Cartao>
          )}

          {baixa && p.status === "aguardando_pagamento" && !(parcelas && parcelas.length > 0) && (
            <Cartao titulo="Registrar pagamento" className="border-sky-300">
              <FormAcao action={registrarBaixa.bind(null, id)} enviar="Confirmar pagamento" variante="sucesso">
                <Campo rotulo="Data do pagamento" obrigatorio>
                  <input type="date" name="pago_em" required defaultValue={hojeISO()} className="campo" />
                </Campo>
                <Campo rotulo="Valor pago (R$)" ajuda="Deixe em branco se igual ao valor do pagamento.">
                  <input name="valor_pago" inputMode="decimal" placeholder={valorParaCampo(p.valor)} className="campo" />
                </Campo>
                <Campo rotulo="Comprovante">
                  <input type="file" name="comprovante" accept={ACEITOS} className="campo" />
                </Campo>
                <Campo rotulo="Observação">
                  <input name="observacao" className="campo" />
                </Campo>
              </FormAcao>
            </Cartao>
          )}

          {p.status === "rejeitado" && podeAtuar && (
            <Cartao titulo="Reenviar para aprovação">
              <p className="mb-3 text-sm text-slate-600">
                Corrija os dados ou substitua os documentos e reenvie. Será criada uma nova versão.
              </p>
              <FormAcao action={reenviarPagamento.bind(null, id)} enviar="Reenviar">
                <Campo rotulo="O que foi corrigido?">
                  <input name="observacao" className="campo" />
                </Campo>
              </FormAcao>
            </Cartao>
          )}

          {(parcelas?.length || podeParcelar) && (
            <Cartao titulo={`Parcelas${parcelas?.length ? ` (${parcelas.length})` : ""}`} semPadding={!!parcelas?.length}>
              {parcelas && parcelas.length > 0 && (
                <ul className="divide-y divide-slate-100">
                  {parcelas.map((pc) => {
                    const aPagar = Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto);
                    const ajustes = Number(pc.multa) + Number(pc.juros) - Number(pc.desconto);
                    const podePagar = baixa && pc.status !== "pago" && p.status === "aguardando_pagamento";
                    return (
                      <li key={pc.id} className="space-y-2 px-4 py-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-medium">Parcela {pc.numero} de {parcelas.length}</div>
                            <div className="text-xs text-slate-500">Vencimento {data(pc.vencimento)}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold tabular-nums">{moeda(aPagar)}</div>
                            {pc.status === "pago" ? (
                              <Selo cor="verde">Paga em {data(pc.pago_em)}</Selo>
                            ) : (
                              <Selo cor="amarelo">A pagar</Selo>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs text-slate-600">
                          <div>Valor<div className="tabular-nums text-slate-800">{moeda(pc.valor_base)}</div></div>
                          <div>Multa/juros<div className="tabular-nums text-slate-800">{Number(pc.multa) + Number(pc.juros) > 0 ? moeda(Number(pc.multa) + Number(pc.juros)) : "—"}</div></div>
                          <div>Desconto<div className="tabular-nums text-slate-800">{Number(pc.desconto) > 0 ? moeda(pc.desconto) : "—"}</div></div>
                        </div>
                        {ajustes !== 0 && pc.status !== "pago" && <div className="text-xs text-slate-500">Ajustes previstos: {moeda(ajustes)}</div>}
                        {podePagar && (
                          <details>
                            <summary className="cursor-pointer text-xs font-medium text-marca-700">Pagar esta parcela</summary>
                            <div className="mt-2">
                              <FormAcao action={registrarBaixaParcela.bind(null, pc.id, p.id)} enviar="Confirmar pagamento" variante="sucesso" className="space-y-3">
                                <p className="text-xs text-slate-600">Houve multa, juros ou desconto nesta parcela?</p>
                                <div className="grid grid-cols-3 gap-2">
                                  <Campo rotulo="Multa (R$)"><input name="multa" inputMode="decimal" placeholder="0,00" className="campo tabular-nums" /></Campo>
                                  <Campo rotulo="Juros (R$)"><input name="juros" inputMode="decimal" placeholder="0,00" className="campo tabular-nums" /></Campo>
                                  <Campo rotulo="Desconto (R$)"><input name="desconto" inputMode="decimal" placeholder="0,00" className="campo tabular-nums" /></Campo>
                                </div>
                                <Campo rotulo="Motivo" ajuda="Obrigatório se houver multa, juros ou desconto.">
                                  <input name="motivo" className="campo" />
                                </Campo>
                                <Campo rotulo="Data do pagamento">
                                  <input type="date" name="pago_em" required defaultValue={hojeISO()} className="campo" />
                                </Campo>
                                <Campo rotulo="Observação (opcional)">
                                  <input name="observacao" className="campo" />
                                </Campo>
                              </FormAcao>
                            </div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {podeParcelar && !(parcelas && parcelas.length > 0) && (
                <div className={parcelas?.length ? "border-t border-slate-200 p-4" : ""}>
                  {parcelas?.length ? <p className="mb-3 text-xs text-slate-500">Para refazer a divisão, informe as parcelas de novo.</p> : null}
                  <FormParcelas pagamentoId={p.id} valorTotal={Number(p.valor)} action={definirParcelas} />
                </div>
              )}
            </Cartao>
          )}
          {!assinaturaUrl &&
            ((p.status === "aguardando_engenheiro" && u.perfil === "engenheiro") ||
              (p.status === "aguardando_administrador" && (u.perfil === "administrador" || u.perfil === "administrador_master"))) &&
            ativos.some((d) => d.tipo !== "comprovante" && ["application/pdf", "image/png", "image/jpeg"].includes(d.mime_type ?? "")) && (
              <Cartao titulo="Assinatura necessária">
                <Aviso tipo="alerta">
                  Para assinar os documentos deste pagamento, cadastre antes a imagem da assinatura (PNG ou JPG) em{" "}
                  <Link href="/perfil" className="font-medium underline">Minha assinatura</Link>.
                </Aviso>
              </Cartao>
            )}
          {assinaturaUrl && p.status !== "cancelado" && (
            <AssinadorDocumentos
              documentos={ativos
                .filter((d) => d.tipo !== "comprovante")
                // Só a versão assinada do conteúdo atual: versões assinadas de versões anteriores ficam de fora.
                .filter((d) => d.tipo !== "documento_assinado" || d.pagamento_versao === p.versao)
                .filter((d) => ["application/pdf", "image/png", "image/jpeg"].includes(d.mime_type ?? ""))
                .map((d) => ({
                  id: d.id,
                  nome: d.nome_arquivo,
                  mime: d.mime_type ?? "application/pdf",
                  tipo: d.tipo,
                  base: d.base_assinatura_id,
                  versao: d.versao,
                  enviadoPorId: d.enviado_por,
                  enviadoPorNome: d.enviado?.nome ?? null,
                }))}
              assinaturaUrl={assinaturaUrl}
              assinaturaMime={assinaturaMime}
              pagamentoId={p.id}
              obraId={p.obra_id}
              usuarioId={u.id}
            />
          )}
          <Cartao titulo="Assinaturas">
            {p.assinado_no_cadastro && (
              <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                ✓ Cadastro assinado por {p.criador?.nome} (marca de quem cadastrou; não é etapa de aprovação).
              </p>
            )}
            {assinaturas && assinaturas.length > 0 ? (
              <ul className="space-y-3">
                {assinaturas.map((a) => (
                  <li key={a.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <Selo cor={a.decisao === "aprovado" ? "verde" : "vermelho"}>{a.decisao === "aprovado" ? "Assinado" : "Rejeitado"}</Selo>
                      <span className="font-medium">{a.user_nome}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {a.etapa === "engenheiro" ? "Engenheiro" : "Administrador"} · versão {a.pagamento_versao}
                      {a.pagamento_versao !== p.versao && " (anterior)"} · {dataHora(a.created_at)}
                    </div>
                    {a.comentario && <div className="mt-0.5 text-xs text-slate-700">“{a.comentario}”</div>}
                    <div className="mt-0.5 font-mono text-[10px] break-all text-slate-400" title="Hash de integridade do conteúdo assinado">
                      {a.hash_integridade}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">
                {p.fluxo === "C" ? "Esta obra não exige assinaturas (fluxo C)." : "Nenhuma assinatura ainda."}
              </p>
            )}
          </Cartao>

          {atua && (
            <Cartao titulo="Cancelar pagamento">
              <details>
                <summary className="cursor-pointer text-sm text-red-700">Cancelar este pagamento…</summary>
                <div className="mt-3">
                  <FormAcao
                    action={cancelarPagamento.bind(null, id)}
                    enviar="Cancelar pagamento"
                    variante="perigo"
                    confirmar="Confirma o cancelamento deste pagamento?"
                  >
                    <Campo rotulo="Motivo" obrigatorio>
                      <input name="motivo" required className="campo" />
                    </Campo>
                  </FormAcao>
                </div>
              </details>
            </Cartao>
          )}
        </div>
      </div>
    </>
  );
}
