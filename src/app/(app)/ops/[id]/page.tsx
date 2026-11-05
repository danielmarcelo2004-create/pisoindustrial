import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Cartao, Dado, LinkBotao, Selo, classeBotao, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { carregarOP } from "@/lib/consultas/ops";
import { cpfCnpj, data, dataHora, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, STATUS_OP, type StatusOP } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { duplicarOP, enviarOP, excluirOP } from "../actions";

export const metadata: Metadata = { title: "Solicitação de OP" };

const ETAPAS: { s: StatusOP[]; rotulo: string }[] = [
  { s: ["em_elaboracao"], rotulo: "Em elaboração" },
  { s: ["enviada"], rotulo: "Enviada" },
  { s: ["em_analise"], rotulo: "Em análise" },
  { s: ["aprovada", "rejeitada"], rotulo: "Aprovada / rejeitada" },
  { s: ["paga"], rotulo: "Paga" },
];

export default async function OPPage({ params, searchParams }: PageProps<"/ops/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const u = await getUsuario();
  const op = await carregarOP(id);
  if (!op) notFound();
  const meu = op.solicitante_id === u.id;
  const rascunho = op.status === "em_elaboracao";
  const subtotal = op.ordem_itens.reduce((s, i) => s + Number(i.total), 0);
  const total = subtotal - Number(op.desconto);
  const atual = ETAPAS.findIndex((e) => e.s.includes(op.status));
  const pag = op.pagamento ?? null;

  let pdfDoc: { id: string } | null = null;
  if (pag) {
    const supabase = await createClient();
    const { data: d } = await supabase
      .from("documentos")
      .select("id")
      .eq("pagamento_id", pag.id)
      .eq("tipo", "ordem_pagamento")
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    pdfDoc = d;
  }

  return (
    <>
      <Cabecalho
        voltar={{ href: "/ops", rotulo: u.perfil === "engenheiro" ? "Minhas solicitações" : "Solicitações de OP" }}
        titulo={
          <span className="flex flex-wrap items-center gap-3">
            {op.numero ?? "Solicitação (rascunho)"}
            <Selo cor={STATUS_OP[op.status].cor}>{STATUS_OP[op.status].rotulo}</Selo>
          </span>
        }
        subtitulo={`${op.favorecido} · ${op.obra?.nome}`}
        acoes={
          <>
            {pdfDoc ? (
              <a href={`/documentos/${pdfDoc.id}`} target="_blank" rel="noopener" className={classeBotao("secundario")}>
                Abrir PDF da OP
              </a>
            ) : (
              <a href={`/ops/${id}/pdf`} target="_blank" rel="noopener" className={classeBotao("secundario")}>
                Pré-visualizar PDF
              </a>
            )}
            {pag && (
              <LinkBotao href={`/pagamentos/${pag.id}`} variante="secundario">
                Ver pagamento nº {pag.numero}
              </LinkBotao>
            )}
          </>
        }
      />

      <div className="mb-4 space-y-3">
        {sp.salva && <Aviso tipo="sucesso">Rascunho salvo. Revise e clique em “Enviar” quando estiver pronto.</Aviso>}
        {sp.enviada && (
          <Aviso tipo="sucesso">
            OP enviada. O PDF foi gerado com o número {op.numero} e você acompanha o andamento por aqui.
          </Aviso>
        )}
        {typeof sp.aviso === "string" && <Aviso tipo="alerta">{sp.aviso}</Aviso>}
        {op.status === "rejeitada" && pag && (
          <Aviso tipo="erro">
            <strong>Rejeitada.</strong> Motivo: {pag.rejeicao_motivo}
          </Aviso>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <ol className="flex flex-wrap items-center gap-y-2 text-xs">
          {ETAPAS.map((e, i) => (
            <li key={e.rotulo} className="flex items-center">
              <span
                className={cx(
                  "rounded-full px-2.5 py-1 font-medium",
                  i < atual || op.status === "paga"
                    ? "bg-emerald-50 text-emerald-800"
                    : i === atual
                      ? op.status === "rejeitada"
                        ? "bg-red-100 text-red-800 ring-1 ring-red-300"
                        : "bg-amber-100 text-amber-900 ring-1 ring-amber-400"
                      : "bg-slate-100 text-slate-500",
                )}
              >
                {i === 3 && op.status === "rejeitada" ? "Rejeitada" : i === 3 && op.status === "aprovada" ? "Aprovada" : e.rotulo}
              </span>
              {i < ETAPAS.length - 1 && <span className="mx-1 text-slate-300">—</span>}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Cartao titulo="Dados">
            <dl className="grid gap-4 sm:grid-cols-3">
              <Dado rotulo="Valor total">
                <span className="text-lg font-semibold tabular-nums">{moeda(total)}</span>
              </Dado>
              <Dado rotulo="Vencimento">{data(op.vencimento)}</Dado>
              <Dado rotulo="Forma de pagamento">{FORMAS_PAGAMENTO[op.forma_pagamento]}</Dado>
              <Dado rotulo="Nº da Nota Fiscal">{op.numero_nf ?? "—"}</Dado>
              <Dado rotulo="Favorecido">{op.favorecido}</Dado>
              <Dado rotulo="CPF / CNPJ">{op.cpf_cnpj ? cpfCnpj(op.cpf_cnpj) : "—"}</Dado>
              <Dado rotulo="Dados para pagamento">{op.dados_bancarios ?? "—"}</Dado>
              <div className="sm:col-span-3">
                <Dado rotulo="Descrição">{op.descricao}</Dado>
              </div>
              {op.observacoes && (
                <div className="sm:col-span-3">
                  <Dado rotulo="Observações">{op.observacoes}</Dado>
                </div>
              )}
              <Dado rotulo="Centro de custo">
                {op.obra?.nome}
                <div className="text-xs text-slate-500">
                  {op.obra?.cidade}/{op.obra?.uf}
                </div>
              </Dado>
              <Dado rotulo="Solicitante">{op.solicitante?.nome}</Dado>
              <Dado rotulo="Enviada em">{op.enviada_em ? dataHora(op.enviada_em) : "—"}</Dado>
            </dl>
          </Cartao>
          <Cartao titulo={`Itens (${op.ordem_itens.length})`} semPadding>
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Descrição</th>
                    <th>Un</th>
                    <th className="text-right">Qtd</th>
                    <th className="text-right">Valor unit.</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {op.ordem_itens.map((i) => (
                    <tr key={i.id}>
                      <td className="text-slate-500">{i.posicao}</td>
                      <td>{i.descricao}</td>
                      <td>{i.unidade}</td>
                      <td className="text-right tabular-nums">{Number(i.quantidade).toLocaleString("pt-BR")}</td>
                      <td className="text-right tabular-nums">{moeda(i.valor_unitario)}</td>
                      <td className="text-right font-medium tabular-nums">{moeda(i.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{moeda(subtotal)}</td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                      Desconto
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(op.desconto) > 0 ? `- ${moeda(op.desconto)}` : "—"}</td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="px-3 py-2.5 text-right font-semibold">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{moeda(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Cartao>
        </div>

        <div className="min-w-0 space-y-6">
          {meu && rascunho && (
            <Cartao titulo="Ações">
              <div className="space-y-3">
                <LinkBotao href={`/ops/${id}/editar`} variante="secundario" className="w-full">
                  Editar rascunho
                </LinkBotao>
                <FormAcao
                  action={enviarOP.bind(null, id)}
                  enviar="Enviar OP"
                  pendente="Enviando…"
                  confirmar="Enviar esta OP? Após o envio ela não poderá mais ser alterada."
                />
                <p className="text-xs text-slate-500">
                  Ao enviar, a OP recebe número, o PDF é gerado e ela segue direto ao administrador da obra.
                </p>
                <FormAcao action={excluirOP.bind(null, id)} enviar="Excluir rascunho" variante="fantasma" confirmar="Excluir este rascunho?" />
              </div>
            </Cartao>
          )}
          {meu && (op.status === "rejeitada" || op.status === "cancelada") && (
            <Cartao titulo="Corrigir e reenviar">
              <p className="mb-3 text-sm text-slate-600">Crie um novo rascunho com os mesmos dados para corrigir e enviar novamente.</p>
              <FormAcao action={duplicarOP.bind(null, id)} enviar="Criar nova solicitação a partir desta" variante="secundario" />
            </Cartao>
          )}
          {pag && (
            <Cartao titulo="Acompanhamento">
              <p className="text-sm text-slate-600">
                Esta OP gerou o{" "}
                <Link href={`/pagamentos/${pag.id}`} className="text-marca-700 hover:underline">
                  pagamento nº {pag.numero}
                </Link>
                . Lá você vê as assinaturas e a linha do tempo completa.
              </p>
              {pag.pago_em && <p className="mt-2 text-sm font-medium text-emerald-700">Paga em {data(pag.pago_em)}.</p>}
            </Cartao>
          )}
        </div>
      </div>
    </>
  );
}
