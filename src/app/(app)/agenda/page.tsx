import type { Metadata } from "next";
import Link from "next/link";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Cabecalho, Cartao, cx } from "@/components/ui";
import { pagamentosEmAberto, somar, type PagamentoLista } from "@/lib/consultas/pagamentos";
import { createClient } from "@/lib/supabase/server";
import { data, hojeISO, moeda, somarDias } from "@/lib/formato";

export const metadata: Metadata = { title: "Agenda de pagamentos" };

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type ProvisaoAgenda = {
  id: string;
  descricao: string;
  vencimento: string | null;
  valor_estimado: number | null;
  mes_referencia: string | null;
  obra: { nome: string } | null;
};

function mesValido(s: unknown, padrao: string) {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : padrao;
}
function deslocarMes(mes: string, delta: number) {
  const [a, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function Lista({ id, titulo, itens, cor }: { id: string; titulo: string; itens: PagamentoLista[]; cor: string }) {
  return (
    <div id={id} className="scroll-mt-20">
      <Cartao
        titulo={
          <span className="flex items-center gap-2">
            <span className={cx("h-2.5 w-2.5 rounded-full", cor)} />
            {titulo}
            <span className="font-normal text-slate-500">
              · {itens.length} · {moeda(somar(itens))}
            </span>
          </span>
        }
        semPadding
      >
        <TabelaPagamentos itens={itens} vazio="Nenhum pagamento." />
      </Cartao>
    </div>
  );
}

function ListaProvisoes({ id, titulo, itens }: { id: string; titulo: string; itens: ProvisaoAgenda[] }) {
  return (
    <div id={id} className="scroll-mt-20">
      <Cartao titulo={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-violet-500" />{titulo}</span>} semPadding>
        {!itens.length ? (
          <div className="px-4 py-4 text-sm text-slate-500">Nenhuma provisão.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {itens.map((pr) => (
              <li key={pr.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-medium">{pr.descricao}</span>
                  <span className="text-slate-500"> · {pr.obra?.nome}{pr.mes_referencia ? ` · ref. ${pr.mes_referencia}` : ""}</span>
                </span>
                <span className="tabular-nums text-slate-600">{pr.valor_estimado === null ? "valor a definir" : moeda(pr.valor_estimado)}</span>
              </li>
            ))}
          </ul>
        )}
      </Cartao>
    </div>
  );
}

export default async function AgendaPage({ searchParams }: PageProps<"/agenda">) {
  const sp = await searchParams;
  const hoje = hojeISO();
  const mes = mesValido(sp.mes, hoje.slice(0, 7));
  const diaSel = typeof sp.dia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.dia) ? sp.dia : null;

  const abertos = await pagamentosEmAberto();
  const provisoesSupabase = await createClient();
  const { data: provisoes } = await provisoesSupabase
    .from("provisoes")
    .select("id, descricao, vencimento, valor_estimado, mes_referencia, obra:obras(nome)")
    .eq("status", "provisionada")
    .order("vencimento", { ascending: true, nullsFirst: false });
  const vencidos = abertos.filter((p) => p.vencimento < hoje);
  const deHoje = abertos.filter((p) => p.vencimento === hoje);
  const proximos = abertos.filter((p) => p.vencimento > hoje && p.vencimento <= somarDias(hoje, 15));

  // Provisões em aberto por data de vencimento (aparecem na agenda para não serem esquecidas;
  // não entram nos totais, pois ainda não são pagamentos)
  const provPorDia = new Map<string, ProvisaoAgenda[]>();
  for (const pr of (provisoes ?? []) as ProvisaoAgenda[]) {
    if (!pr.vencimento) continue;
    const l = provPorDia.get(pr.vencimento) ?? [];
    l.push(pr);
    provPorDia.set(pr.vencimento, l);
  }
  const provisoesHoje = (provisoes ?? []).filter((pr) => pr.vencimento === hoje) as ProvisaoAgenda[];

  // Totais por data
  const porDia = new Map<string, PagamentoLista[]>();
  for (const p of abertos) {
    const l = porDia.get(p.vencimento) ?? [];
    l.push(p);
    porDia.set(p.vencimento, l);
  }

  const [ano, m] = mes.split("-").map(Number);
  const primeiro = new Date(Date.UTC(ano, m - 1, 1));
  const diasNoMes = new Date(Date.UTC(ano, m, 0)).getUTCDate();
  const celulas: (string | null)[] = [
    ...Array(primeiro.getUTCDay()).fill(null),
    ...Array.from({ length: diasNoMes }, (_, i) => `${mes}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (celulas.length % 7) celulas.push(null);

  const totalMes = abertos.filter((p) => p.vencimento.startsWith(mes));

  return (
    <>
      <Cabecalho titulo="Agenda de pagamentos" subtitulo="Pagamentos em aberto (em aprovação ou liberados) por data de vencimento" />

      <Cartao
        titulo={
          <span>
            {MESES[m - 1]} de {ano}
            <span className="ml-2 font-normal text-slate-500">
              · {totalMes.length} pagamentos · {moeda(somar(totalMes))}
            </span>
          </span>
        }
        acoes={
          <div className="flex gap-1 text-sm">
            <Link href={`/agenda?mes=${deslocarMes(mes, -1)}`} className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Mês anterior">
              ←
            </Link>
            <Link href="/agenda" className="rounded px-2 py-1 hover:bg-slate-100">
              Hoje
            </Link>
            <Link href={`/agenda?mes=${deslocarMes(mes, 1)}`} className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Próximo mês">
              →
            </Link>
          </div>
        }
      >
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 text-xs">
          {DIAS.map((d) => (
            <div key={d} className="bg-slate-50 py-1.5 text-center font-semibold text-slate-500">
              {d}
            </div>
          ))}
          {celulas.map((dia, i) => {
            if (!dia) return <div key={i} className="min-h-16 bg-slate-50/60 sm:min-h-20" />;
            const itens = porDia.get(dia) ?? [];
            const provs = provPorDia.get(dia) ?? [];
            const vencido = dia < hoje && itens.length > 0;
            const ehHoje = dia === hoje;
            return (
              <Link
                key={dia}
                href={`/agenda?mes=${mes}&dia=${dia}#dia`}
                className={cx(
                  "flex min-h-16 flex-col bg-white p-1.5 hover:bg-marca-50 sm:min-h-20",
                  diaSel === dia && "ring-2 ring-marca-500 ring-inset",
                )}
              >
                <span
                  className={cx(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full tabular-nums",
                    ehHoje ? "bg-marca-700 font-semibold text-white" : "text-slate-600",
                  )}
                >
                  {Number(dia.slice(8))}
                </span>
                {provs.length > 0 && (
                  <span className="mt-0.5 rounded bg-violet-50 px-1 py-0.5 text-[10px] font-medium text-violet-800">
                    {provs.length} prov.
                  </span>
                )}
                {itens.length > 0 && (
                  <span
                    className={cx(
                      "mt-auto rounded px-1 py-0.5 font-medium tabular-nums",
                      vencido ? "bg-red-50 text-red-700" : ehHoje ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800",
                    )}
                  >
                    <span className="hidden sm:inline">{moeda(somar(itens))}</span>
                    <span className="sm:hidden">{itens.length}</span>
                    <span className="hidden text-[10px] font-normal opacity-70 sm:block">
                      {itens.length} pagto{itens.length > 1 ? "s" : ""}
                    </span>
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </Cartao>

      {diaSel && (
        <div id="dia" className="mt-6 scroll-mt-20 space-y-6">
          <Lista id="dia-lista" titulo={`Vencimento em ${data(diaSel)}`} itens={porDia.get(diaSel) ?? []} cor="bg-marca-500" />
          <ListaProvisoes id="dia-provisoes" titulo={`Provisões que vencem em ${data(diaSel)} · não entram nos totais`} itens={provPorDia.get(diaSel) ?? []} />
        </div>
      )}

      <div className="mt-6">
        <Cartao titulo={`Provisões (${provisoes?.length ?? 0}) · não entram nos totais`} semPadding>
          {!provisoes?.length ? (
            <div className="px-4 py-6 text-sm text-slate-500">Nenhuma provisão em aberto.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {provisoes.map((pr) => (
                <li key={pr.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{pr.descricao}</span>
                    <span className="text-slate-500"> · {pr.obra?.nome}{pr.mes_referencia ? ` · ref. ${pr.mes_referencia}` : ""}</span>
                  </span>
                  <span className="tabular-nums text-slate-600">
                    {data(pr.vencimento)} · {pr.valor_estimado === null ? "valor a definir" : moeda(pr.valor_estimado)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Cartao>
      </div>

      <div className="mt-6 space-y-6">
        <Lista id="vencidos" titulo="Vencidos" itens={vencidos} cor="bg-red-500" />
        <Lista id="hoje" titulo="Vencem hoje" itens={deHoje} cor="bg-amber-500" />
        <ListaProvisoes id="hoje-provisoes" titulo="Provisões que vencem hoje · não entram nos totais" itens={provisoesHoje} />
        <Lista id="proximos" titulo="Próximos 15 dias" itens={proximos} cor="bg-sky-500" />
      </div>
    </>
  );
}
