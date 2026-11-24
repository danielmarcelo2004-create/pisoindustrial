import type { Metadata } from "next";
import Link from "next/link";
import { TabelaPagamentos } from "@/components/pagamentos";
import { AgendaCorpo } from "@/components/agenda-corpo";
import { Aviso, Cabecalho, Cartao, Indicador, LinkBotao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { pagamentosEmAberto, SELECAO_LISTA, somar } from "@/lib/consultas/pagamentos";
import { data, hojeISO, moeda, somarDias } from "@/lib/formato";
import { analisarSeries } from "@/lib/provisoes-serie";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Painel" };

export default async function PainelPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const supabase = await createClient();
  const hoje = hojeISO();
  const em7 = somarDias(hoje, 7);
  const inicioMes = hoje.slice(0, 8) + "01";

  const [abertos, pendRes, pagosRes, provVencRes, provSerieRes] = await Promise.all([
    pagamentosEmAberto(),
    supabase.rpc("minhas_pendencias").select(SELECAO_LISTA).order("vencimento").limit(10),
    supabase.from("pagamentos").select("valor_pago, valor").eq("status", "pago").gte("pago_em", inicioMes).lte("pago_em", hoje),
    // Provisões vencidas que ainda não viraram pagamento (Financeiro e Suprimentos acompanham)
    supabase.from("provisoes").select("valor_estimado").eq("status", "provisionada").lt("vencimento", hoje),
    // Séries de provisões (para avisar quando chegam na última parcela)
    supabase.from("provisoes").select("id, descricao, status, vencimento, created_by, pagamento_origem_id, obra:obras(id)").like("descricao", "%(%/%)").limit(1000),
  ]);
  const seriesNaUltima = analisarSeries(provSerieRes.data ?? []).naUltima;

  // Fluxo de caixa previsto (Financeiro/master: depende do saldo dos bancos) e resultado por centro de custo
  const veCaixa = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const [{ data: saldos }, { data: contasCorr }, { data: recsAbertos }, { data: pagosObra }, { data: recsObra }] = await Promise.all([
    veCaixa ? supabase.rpc("saldos_contas_bancarias") : Promise.resolve({ data: [] as { id: string; saldo: number | null }[] }),
    veCaixa ? supabase.from("contas_bancarias").select("id").eq("ativa", true).eq("tipo", "corrente") : Promise.resolve({ data: [] as { id: string }[] }),
    supabase.from("recebimentos").select("valor, vencimento").eq("status", "aberto").limit(5000),
    supabase.from("pagamentos").select("valor, valor_pago, status, obra:obras(nome)").in("status", ["pago", "aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento"]).limit(20000),
    supabase.from("recebimentos").select("valor, valor_recebido, status, obra:obras(nome)").in("status", ["recebido", "aberto"]).limit(20000),
  ]);
  const correntes = new Set((contasCorr ?? []).map((c) => c.id));
  const saldoBancos = (saldos ?? []).filter((x) => correntes.has(x.id)).reduce((t, x) => t + Number(x.saldo ?? 0), 0);
  let acumulado = saldoBancos;
  const semanas = [0, 1, 2, 3].map((k) => {
    const ini = somarDias(hoje, k * 7);
    const fim = somarDias(hoje, k * 7 + 6);
    const dentro = (v: string) => (k === 0 ? v <= fim : v >= ini && v <= fim);
    const entradas = (recsAbertos ?? []).filter((r) => dentro(r.vencimento)).reduce((t, r) => t + Number(r.valor), 0);
    const saidas = abertos.filter((p) => dentro(p.vencimento)).reduce((t, p) => t + Number(p.valor), 0);
    acumulado += entradas - saidas;
    return { rotulo: `${data(ini).slice(0, 5)} a ${data(fim).slice(0, 5)}`, entradas, saidas, saldo: acumulado };
  });
  const porObra = new Map<string, { obra: string; recebido: number; pago: number; aReceber: number; aPagar: number }>();
  const linhaObra = (nome: string) => porObra.get(nome) ?? (porObra.set(nome, { obra: nome, recebido: 0, pago: 0, aReceber: 0, aPagar: 0 }), porObra.get(nome)!);
  const nomeObra = (o: unknown) => ((Array.isArray(o) ? o[0] : o) as { nome: string } | null)?.nome ?? "—";
  for (const p of pagosObra ?? []) {
    const l = linhaObra(nomeObra(p.obra));
    if (p.status === "pago") l.pago += Number(p.valor_pago ?? p.valor);
    else l.aPagar += Number(p.valor);
  }
  for (const r of recsObra ?? []) {
    const l = linhaObra(nomeObra(r.obra));
    if (r.status === "recebido") l.recebido += Number(r.valor_recebido ?? r.valor);
    else l.aReceber += Number(r.valor);
  }
  const resultado = [...porObra.values()].sort((a, b) => a.obra.localeCompare(b.obra, "pt-BR"));
  const provVencidas = provVencRes.data ?? [];

  const vencidos = abertos.filter((p) => p.vencimento < hoje);
  const deHoje = abertos.filter((p) => p.vencimento === hoje);
  const proximos = abertos.filter((p) => p.vencimento > hoje && p.vencimento <= em7);
  const emAprovacao = abertos.filter((p) => p.status === "aguardando_engenheiro" || p.status === "aguardando_administrador");
  const liberados = abertos.filter((p) => p.status === "aguardando_pagamento");
  const pagosMes = (pagosRes.data ?? []).reduce((s, p) => s + Number(p.valor_pago ?? p.valor), 0);
  const pendencias = pendRes.data ?? [];

  const assinante = u.perfil === "engenheiro" || u.perfil === "administrador" || u.perfil === "administrador_master";

  return (
    <>
      <Cabecalho
        titulo={`Olá, ${u.nome.split(" ")[0]}`}
        subtitulo={
          u.perfil === "financeiro"
            ? "Visão geral de todas as obras"
            : u.perfil === "suprimentos"
              ? "Visão geral das obras"
              : "Visão das obras sob sua responsabilidade"
        }
      />

      {sp["senha"] === "alterada" && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Senha definida com sucesso.</Aviso>
        </div>
      )}
      {sp["sem-permissao"] && (
        <div className="mb-4">
          <Aviso tipo="alerta">Você não tem permissão para acessar aquela página.</Aviso>
        </div>
      )}

      {provVencidas.length > 0 && (u.perfil === "financeiro" || u.perfil === "suprimentos" || u.perfil === "administrador_master") && (
        <div className="mb-4">
          <Aviso tipo="alerta">
            {provVencidas.length === 1 ? "1 provisão venceu" : `${provVencidas.length} provisões venceram`} sem virar pagamento
            {provVencidas.some((x) => x.valor_estimado !== null)
              ? ` (${moeda(provVencidas.reduce((s, x) => s + Number(x.valor_estimado ?? 0), 0))} estimados)`
              : ""}
            .{" "}
            <Link href="/provisoes?situacao=vencidas" className="font-medium underline">
              Ver provisões vencidas
            </Link>
          </Aviso>
        </div>
      )}

      {seriesNaUltima.length > 0 && (u.perfil === "financeiro" || u.perfil === "suprimentos" || u.perfil === "administrador_master") && (
        <div className="mb-4">
          <Aviso tipo="info">
            {seriesNaUltima.length === 1 ? "1 série de provisões está na última parcela" : `${seriesNaUltima.length} séries de provisões estão na última parcela`}.
            Deseja adicionar mais parcelas?{" "}
            <Link href="/provisoes?situacao=ultimas" className="font-medium underline">
              Ver últimas parcelas
            </Link>
          </Aviso>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Indicador rotulo="Vencidos" valor={vencidos.length} detalhe={moeda(somar(vencidos))} cor="vermelho" href="/?ver=vencidos#lista" />
        <Indicador rotulo="Vencem hoje" valor={deHoje.length} detalhe={moeda(somar(deHoje))} cor="amarelo" href="/?ver=hoje#lista" />
        <Indicador rotulo="Próximos 7 dias" valor={proximos.length} detalhe={moeda(somar(proximos))} cor="azul" href="/?ver=proximos#lista" />
        <Indicador
          rotulo="Em aprovação"
          valor={emAprovacao.length}
          detalhe={moeda(somar(emAprovacao))}
          cor="amarelo"
          href="/pagamentos?status=em_aprovacao"
        />
        <Indicador
          rotulo="A pagar"
          valor={liberados.length}
          detalhe={moeda(somar(liberados))}
          cor="marca"
          href="/pagamentos?status=aguardando_pagamento"
        />
        <Indicador rotulo="Pagos no mês" valor={moeda(pagosMes)} cor="verde" href="/pagamentos?status=pago" />
      </div>

      {assinante && (
        <div className="mt-6">
          <Cartao
            titulo={`Aguardando sua assinatura (${pendencias.length})`}
            acoes={
              <LinkBotao href="/aprovacoes" variante="secundario" tamanho="sm">
                Assinar em lote
              </LinkBotao>
            }
            semPadding
          >
            <TabelaPagamentos itens={pendencias} vazio="Nenhuma pendência no momento." compacto />
          </Cartao>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 2xl:grid-cols-2">
        {veCaixa && (
          <Cartao titulo="Fluxo de caixa previsto · próximas 4 semanas" semPadding>
            <table className="w-full text-sm" data-fluxo-previsto>
              <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2">Semana</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Entradas</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Saídas</th>
                  <th className="px-4 py-2 text-right">Saldo previsto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">Saldo nos bancos hoje</td>
                  <td className="hidden sm:table-cell" />
                  <td className="hidden sm:table-cell" />
                  <td className="px-4 py-2 text-right font-medium whitespace-nowrap tabular-nums">{moeda(saldoBancos)}</td>
                </tr>
                {semanas.map((w) => (
                  <tr key={w.rotulo}>
                    <td className="px-4 py-2 whitespace-nowrap">{w.rotulo}</td>
                    <td className="hidden px-4 py-2 text-right text-emerald-700 whitespace-nowrap tabular-nums sm:table-cell">{w.entradas ? moeda(w.entradas) : "—"}</td>
                    <td className="hidden px-4 py-2 text-right text-red-600 whitespace-nowrap tabular-nums sm:table-cell">{w.saidas ? moeda(w.saidas) : "—"}</td>
                    <td className={`px-4 py-2 text-right font-semibold whitespace-nowrap tabular-nums ${w.saldo < 0 ? "text-red-700" : "text-slate-800"}`}>{moeda(w.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              Saldo do último extrato de cada conta + contas a receber − contas a pagar em aberto (vencidos entram na 1ª semana). Provisões não entram.
            </p>
          </Cartao>
        )}
        <Cartao titulo="Resultado por centro de custo" semPadding className={veCaixa ? undefined : "2xl:col-span-2"}>
          {resultado.length === 0 ? (
            <div className="px-4 py-4 text-sm text-slate-500">Sem lançamentos ainda.</div>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm" data-resultado-obras>
                {resultado.map((r) => (
                  <li key={r.obra} className="flex items-start justify-between gap-4 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800">{r.obra}</div>
                      <div className="text-xs text-slate-500">
                        a receber {moeda(r.aReceber)} · a pagar {moeda(r.aPagar)}
                      </div>
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <div className={`font-semibold tabular-nums ${r.recebido - r.pago < 0 ? "text-red-700" : "text-emerald-800"}`}>{moeda(r.recebido - r.pago)}</div>
                      <div className="text-xs text-slate-500 tabular-nums">
                        recebido {moeda(r.recebido)} · pago {moeda(r.pago)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
          )}
        </Cartao>
      </div>

      <div className="mt-6">
        <AgendaCorpo sp={sp} calendario={false} />
      </div>
    </>
  );
}
