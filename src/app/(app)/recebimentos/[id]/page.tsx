import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Campo, Cartao, Dado, Selo } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { recebimento, situacaoReceber } from "@/lib/consultas/contas-a-receber";
import { categoriasAtivas } from "@/lib/consultas/categorias";
import { createClient } from "@/lib/supabase/server";
import { data, hojeISO, moeda } from "@/lib/formato";
import { cancelarReceita, editarRecebimento, enviarNotaNoRecebimento, vincularNota } from "../actions";

export const metadata: Metadata = { title: "Recebimento" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITUACAO = {
  recebido: { r: "Recebido ✓", c: "verde" },
  vencido: { r: "Vencido", c: "vermelho" },
  hoje: { r: "Vence hoje", c: "vermelho" },
  a_receber: { r: "A receber", c: "azul" },
  cancelado: { r: "Cancelado", c: "cinza" },
} as const;

export default async function RecebimentoPage({ params, searchParams }: PageProps<"/recebimentos/[id]">) {
  const { id } = await params;
  const criada = (await searchParams).criada === "1";
  if (!UUID.test(id)) notFound();
  const u = await getUsuario();
  const r = await recebimento(id);
  if (!r) notFound();
  const podeMexer = (u.perfil === "financeiro" || u.perfil === "administrador_master") && r.status !== "cancelado";
  const supabase = await createClient();
  const [categorias, { data: obras }] = podeMexer ? await Promise.all([categoriasAtivas("receita"), supabase.from("obras").select("id, nome").order("nome")]) : [[], { data: [] }];
  const sit = SITUACAO[situacaoReceber(r.status, r.vencimento, hojeISO())];

  return (
    <>
      <Cabecalho
        titulo={`Recebimento nº ${r.numero}`}
        subtitulo={`${r.cliente} · ${moeda(Number(r.valor))}`}
        acoes={
          <Link href="/recebimentos" className="text-sm text-sky-700 hover:underline">
            ← Contas a receber
          </Link>
        }
      />
      {criada && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Receita lançada. Ela fica em aberto até a entrada aparecer no extrato: a conciliação sugere esta receita.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Cartao titulo="Dados">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Dado rotulo="Situação">
                <Selo cor={sit.c}>{sit.r}</Selo>
              </Dado>
              <Dado rotulo="Valor">{moeda(Number(r.valor))}</Dado>
              <Dado rotulo="Recebido em">{r.recebido_em ? `${data(r.recebido_em)} · ${moeda(Number(r.valor_recebido))}` : "—"}</Dado>
              <Dado rotulo="Cliente">{r.cliente}</Dado>
              <Dado rotulo="Centro de custo">{r.obra?.nome}</Dado>
              <Dado rotulo="Categoria">{r.categoria?.nome ?? "—"}</Dado>
              <Dado rotulo="Vencimento">{data(r.vencimento)}</Dado>
              <Dado rotulo="Competência">{data(r.data_competencia)}</Dado>
              <Dado rotulo="Conta bancária">{r.conta?.nome ?? "—"}</Dado>
            </dl>
            <p className="mt-4 text-sm text-slate-700">{r.descricao}</p>
            {r.observacoes && <p className="mt-2 text-sm whitespace-pre-line text-slate-600">{r.observacoes}</p>}
            {r.lancado_conciliacao && (
              <p className="mt-3 inline-block rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">
                Lançado pela conciliação{r.linha ? ` · extrato de ${data(r.linha.data)}: “${r.linha.descricao}”` : ""}
              </p>
            )}
            {r.status === "cancelado" && <p className="mt-3 text-sm text-red-700">Cancelado{r.cancelamento_motivo ? `: ${r.cancelamento_motivo}` : ""}</p>}
          </Cartao>

          {r.impostos.length > 0 && (
            <Cartao titulo="Impostos da medição" semPadding>
              <ul className="divide-y divide-slate-100 text-sm" data-impostos-medicao>
                {r.impostos.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <Link href={`/pagamentos/${i.id}`} className="text-marca-700 hover:underline">
                      nº {i.numero} · Imposto {i.imposto_medicao}
                    </Link>
                    <span className="tabular-nums">{moeda(Number(i.valor))}</span>
                    <Selo cor={i.status === "pago" ? "verde" : i.status === "cancelado" ? "cinza" : "azul"}>
                      {i.status === "pago" ? `Pago${i.pago_em ? ` em ${data(i.pago_em)}` : ""}` : i.status === "cancelado" ? "Cancelado" : "A pagar (baixa na conciliação)"}
                    </Selo>
                  </li>
                ))}
              </ul>
            </Cartao>
          )}

          {podeMexer && r.status === "aberto" && (
            <Cartao titulo="Cancelar receita">
              <FormAcao action={cancelarReceita.bind(null, r.id)} enviar="Cancelar receita" variante="perigo" confirmar="Cancelar esta receita (e os impostos ainda não pagos)?" className="flex flex-wrap items-end gap-2">
                <input name="motivo" required minLength={3} placeholder="Motivo" className="campo sm:max-w-sm" aria-label="Motivo do cancelamento" />
              </FormAcao>
            </Cartao>
          )}

          {podeMexer && (
            <Cartao titulo="Editar">
              <FormAcao action={editarRecebimento.bind(null, r.id)} className="grid gap-3 sm:grid-cols-2">
                <Campo rotulo="Descrição" obrigatorio className="sm:col-span-2">
                  <input name="descricao" required defaultValue={r.descricao} maxLength={300} className="campo" />
                </Campo>
                <Campo rotulo="Cliente" obrigatorio>
                  <input name="cliente" required defaultValue={r.cliente} maxLength={200} className="campo" />
                </Campo>
                <Campo rotulo="Centro de custo" obrigatorio>
                  <select name="obra_id" defaultValue={r.obra_id} className="campo">
                    {(obras ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.nome}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo rotulo="Categoria de receita">
                  <select name="categoria_id" defaultValue={r.categoria_id ?? ""} className="campo">
                    <option value="">— Sem categoria —</option>
                    {categorias.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo rotulo="Competência">
                  <input type="date" name="competencia" defaultValue={r.data_competencia ?? ""} className="campo" />
                </Campo>
                <Campo rotulo="Observações" className="sm:col-span-2">
                  <textarea name="observacoes" defaultValue={r.observacoes ?? ""} rows={2} className="campo" />
                </Campo>
              </FormAcao>
              <p className="mt-2 text-xs text-slate-500">Valor e datas vêm do extrato do banco e não mudam aqui. Para corrigir, desfaça a conciliação em Contas bancárias › Movimentações.</p>
            </Cartao>
          )}
        </div>

        <Cartao titulo="Nota de medição">
          {r.nota ? (
            <div className="space-y-1 text-sm" data-nota-anexada>
              <div className="font-medium text-slate-800">📎 {r.nota.numero ? `Nota nº ${r.nota.numero}` : r.nota.nome_arquivo}</div>
              <div className="text-slate-600">
                Valor {moeda(Number(r.nota.valor))} · líquido {moeda(Number(r.nota.valor_liquido))}
                {r.nota.data_emissao ? ` · emitida em ${data(r.nota.data_emissao)}` : ""}
              </div>
              {Math.abs(Number(r.nota.valor_liquido) - Number(r.valor)) >= 0.01 && (
                <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                  O líquido da nota ({moeda(Number(r.nota.valor_liquido))}) é diferente do valor recebido ({moeda(Number(r.valor))}).
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Nenhuma nota anexada. Nem todo recebimento é medição: a nota é opcional.</p>
          )}
          {podeMexer && (
            <FormAcao action={vincularNota.bind(null, r.id)} enviar={r.nota ? "Trocar" : "Anexar"} className="mt-4 space-y-2">
              <select name="nota_id" defaultValue={r.nota_medicao_id ?? ""} className="campo" aria-label="Nota de medição">
                <option value="">{r.nota ? "— Retirar a nota —" : "Escolha a nota de medição…"}</option>
                {r.notasDisponiveis.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.numero ? `Nº ${n.numero}` : n.nome_arquivo} · {moeda(Number(n.valor_liquido))} líquido{n.data_emissao ? ` · ${data(n.data_emissao)}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">Só aparecem as notas do mesmo centro de custo ainda não anexadas.</p>
            </FormAcao>
          )}
          {podeMexer && u.perfil === "financeiro" && !r.nota && (
            <details className="mt-4 border-t border-slate-100 pt-3" data-enviar-nota>
              <summary className="cursor-pointer text-sm font-medium text-sky-700">Enviar nota nova</summary>
              <FormAcao action={enviarNotaNoRecebimento.bind(null, r.id)} enviar="Enviar e anexar" pendente="Enviando…" className="mt-3 space-y-2">
                <input type="file" name="arquivo" required accept=".pdf,.xml,.png,.jpg,.jpeg" className="campo" aria-label="Arquivo da nota de medição" />
                <div className="grid grid-cols-2 gap-2">
                  <input name="valor" required inputMode="decimal" placeholder="Valor total *" className="campo" aria-label="Valor total da nota" />
                  <input name="valor_liquido" required inputMode="decimal" defaultValue={Number(r.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} placeholder="Valor líquido *" className="campo" aria-label="Valor líquido da nota" />
                </div>
                <input name="numero" placeholder="Número da nota (lido do arquivo se for NFS-e)" className="campo" aria-label="Número da nota" maxLength={60} />
                <p className="text-xs text-slate-500">PDF, XML, PNG ou JPG. A nota também aparece em Notas de medição.</p>
              </FormAcao>
            </details>
          )}
        </Cartao>
      </div>
    </>
  );
}
