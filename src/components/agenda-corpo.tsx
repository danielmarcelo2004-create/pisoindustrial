import Link from "next/link";
import { JanelaProvisao } from "@/components/janela-provisao";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Cartao, cx } from "@/components/ui";
import { pagamentosEmAberto, somar, type PagamentoLista } from "@/lib/consultas/pagamentos";
import { createClient } from "@/lib/supabase/server";
import { getUsuario } from "@/lib/auth";
import { data, hojeISO, moeda, somarDias } from "@/lib/formato";


const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type ProvisaoAgenda = {
  id: string;
  descricao: string;
  vencimento: string | null;
  valor_estimado: number | null;
  mes_referencia: string | null;
  created_by: string;
  pagamento_origem_id: string | null;
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


/** Botão "Lançar" da provisão (abre a janela, sem sair da agenda). */
function LancarProvisao({ pr, perfil, usuario }: { pr: ProvisaoAgenda; perfil: string; usuario: string }) {
  if (perfil !== "financeiro" && perfil !== "suprimentos") return null;
  return (
    <JanelaProvisao
      rotulo="Lançar"
      provisao={{ id: pr.id, descricao: pr.descricao, obra: pr.obra?.nome ?? null, vencimento: pr.vencimento, valor: pr.valor_estimado === null ? null : Number(pr.valor_estimado), serie: !!pr.pagamento_origem_id || / \(\d+\/\d+\)$/.test(pr.descricao) }}
      podeAgir={perfil === "financeiro" || pr.created_by === usuario}
    />
  );
}

function ListaProvisoes({ itens, perfil, usuario }: { itens: ProvisaoAgenda[]; perfil: string; usuario: string }) {
  if (!itens.length) return <div className="px-4 py-4 text-sm text-slate-500">Nenhuma provisão.</div>;
  return (
    <ul className="divide-y divide-slate-100">
      {itens.map((pr) => (
        <li key={pr.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
          <span>
            <span className="font-medium">{pr.descricao}</span>
            <span className="text-slate-500"> · {pr.obra?.nome}</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="tabular-nums text-slate-600">
              {data(pr.vencimento)} · {pr.valor_estimado === null ? "valor a definir" : moeda(pr.valor_estimado)}
            </span>
            <LancarProvisao pr={pr} perfil={perfil} usuario={usuario} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Calendário de vencimentos, provisões e listas (Vencidos, Hoje, Próximos) — parte do Painel. */
export async function AgendaCorpo({ sp, base = "/", calendario = true }: { sp: Record<string, string | string[] | undefined>; base?: string; calendario?: boolean }) {
  const u = await getUsuario();
  const podeBaixar = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const hoje = hojeISO();
  const mes = mesValido(sp.mes, hoje.slice(0, 7));
  const diaSel = typeof sp.dia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.dia) ? sp.dia : null;

  const abertos = await pagamentosEmAberto();
  const provisoesSupabase = await createClient();
  const { data: provisoes } = await provisoesSupabase
    .from("provisoes")
    .select("id, descricao, vencimento, valor_estimado, mes_referencia, created_by, pagamento_origem_id, obra:obras(nome)")
    .eq("status", "provisionada")
    .order("vencimento", { ascending: true, nullsFirst: false });
  const vencidos = abertos.filter((p) => p.vencimento < hoje);
  const deHoje = abertos.filter((p) => p.vencimento === hoje);

  // Provisões em aberto por data de vencimento (aparecem na agenda para não serem esquecidas;
  // não entram nos totais, pois ainda não são pagamentos)
  const provPorDia = new Map<string, ProvisaoAgenda[]>();
  for (const pr of (provisoes ?? []) as ProvisaoAgenda[]) {
    if (!pr.vencimento) continue;
    const l = provPorDia.get(pr.vencimento) ?? [];
    l.push(pr);
    provPorDia.set(pr.vencimento, l);
  }

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
  const LIMITE = 8;
  const em7 = somarDias(hoje, 7);
  const proximos7 = abertos.filter((p) => p.vencimento > hoje && p.vencimento <= em7);
  const provisoesAbertas = (provisoes ?? []) as ProvisaoAgenda[];
  const { data: recs } = await (await createClient())
    .from("recebimentos")
    .select("id, numero, cliente, descricao, valor, vencimento, obra:obras(nome)")
    .eq("status", "aberto")
    .lte("vencimento", em7)
    .order("vencimento")
    .limit(200);
  const aReceber = (recs ?? []) as unknown as { id: string; numero: number; cliente: string; descricao: string; valor: number; vencimento: string; obra: { nome: string } | null }[];
  const abas = [
    { id: "vencidos", rotulo: "Vencidos", qtd: vencidos.length, cor: "bg-red-500" },
    { id: "hoje", rotulo: "Vencem hoje", qtd: deHoje.length, cor: "bg-amber-500" },
    { id: "proximos", rotulo: "Próximos 7 dias", qtd: proximos7.length, cor: "bg-sky-500" },
    { id: "receber", rotulo: "A receber (7 dias)", qtd: aReceber.length, cor: "bg-emerald-500" },
    { id: "provisoes", rotulo: "Provisões", qtd: provisoesAbertas.length, cor: "bg-violet-500" },
  ] as const;
  const verParam = typeof sp.ver === "string" ? sp.ver : "";
  const aba = diaSel ? "dia" : (abas.find((a) => a.id === verParam)?.id ?? (vencidos.length ? "vencidos" : deHoje.length ? "hoje" : "proximos"));
  const doDia = diaSel ? (porDia.get(diaSel) ?? []) : [];
  const provDoDia = diaSel ? (provPorDia.get(diaSel) ?? []) : [];
  const itensAba = aba === "dia" ? doDia : aba === "vencidos" ? vencidos : aba === "hoje" ? deHoje : aba === "proximos" ? proximos7 : [];
  const totalAba = aba === "receber" ? aReceber.length : aba === "provisoes" ? provisoesAbertas.length : aba === "dia" ? Math.max(doDia.length, provDoDia.length) : itensAba.length;
  const verTodos =
    aba === "receber" ? "/recebimentos?periodo=todos"
    : aba === "provisoes" ? "/provisoes?ver=abertas"
    : aba === "dia" ? `/pagamentos?periodo=personalizado&de=${diaSel}&ate=${diaSel}`
    : aba === "vencidos" ? "/pagamentos?periodo=todos&cartao=vencidos"
    : aba === "hoje" ? "/pagamentos?periodo=hoje&cartao=hoje"
    : `/pagamentos?periodo=personalizado&de=${somarDias(hoje, 1)}&ate=${em7}`;

  return (
    <>

      {calendario && (
        <>
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
            <Link href={`${base}?mes=${deslocarMes(mes, -1)}`} className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Mês anterior">
              ←
            </Link>
            <Link href={base} className="rounded px-2 py-1 hover:bg-slate-100">
              Hoje
            </Link>
            <Link href={`${base}?mes=${deslocarMes(mes, 1)}`} className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Próximo mês">
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
                href={`${base}?mes=${mes}&dia=${dia}#lista`}
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
        </>
      )}

      {/* Uma lista só, com abas (no máximo 8 itens; "Ver todos" abre a lista completa já filtrada) */}
      <div id="lista" className={cx("scroll-mt-20", calendario && "mt-6")}>
        <Cartao
          titulo={
            <nav className="flex flex-wrap gap-1" aria-label="O que mostrar">
              {abas.map((a) => (
                <Link
                  key={a.id}
                  href={`${base}?mes=${mes}&ver=${a.id}#lista`}
                  aria-current={aba === a.id ? "true" : undefined}
                  data-aba={a.id}
                  className={cx("rounded-full border px-3 py-1 text-sm font-normal", aba === a.id ? "border-marca-700 bg-marca-50 font-semibold text-marca-800" : "border-slate-300 text-slate-700 hover:bg-slate-50")}
                >
                  <span className={cx("mr-1.5 inline-block h-2 w-2 rounded-full", a.cor)} />
                  {a.rotulo} <span className="text-slate-500">({a.qtd})</span>
                </Link>
              ))}
              {diaSel && (
                <span aria-current="true" data-aba="dia" className="rounded-full border border-marca-700 bg-marca-50 px-3 py-1 text-sm font-semibold text-marca-800">
                  Dia {data(diaSel)} ({doDia.length + provDoDia.length})
                </span>
              )}
            </nav>
          }
          acoes={
            <Link href={verTodos} className="text-sm whitespace-nowrap text-marca-700 hover:underline">
              Ver todos →
            </Link>
          }
          semPadding
        >
          {aba === "receber" ? (
            aReceber.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-500">Nada a receber vencido ou nos próximos 7 dias.</div>
            ) : (
              <ul className="divide-y divide-slate-100" data-lista-receber>
                {aReceber.slice(0, LIMITE).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <Link href={`/recebimentos/${r.id}`} className="hover:underline">
                      <span className="font-medium">nº {r.numero} · {r.cliente}</span>
                      <span className="text-slate-500"> · {r.descricao} · {r.obra?.nome}</span>
                    </Link>
                    <span className={cx("tabular-nums", r.vencimento < hoje ? "font-medium text-red-700" : "text-slate-600")}>
                      {data(r.vencimento)} · {moeda(Number(r.valor))}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : aba === "provisoes" || (diaSel && provDoDia.length && !doDia.length) ? (
            <ListaProvisoes itens={(diaSel ? provDoDia : provisoesAbertas).slice(0, LIMITE)} perfil={u.perfil} usuario={u.id} />
          ) : (
            <>
              <TabelaPagamentos itens={itensAba.slice(0, LIMITE)} vazio={diaSel ? "Nenhum pagamento vence neste dia." : "Nada aqui."} baixa={podeBaixar} compacto />
              {diaSel && provDoDia.length > 0 && (
                <div className="border-t border-slate-100">
                  <div className="px-4 pt-3 text-xs font-medium text-violet-800">Provisões deste dia (não entram nos totais)</div>
                  <ListaProvisoes itens={provDoDia.slice(0, LIMITE)} perfil={u.perfil} usuario={u.id} />
                </div>
              )}
            </>
          )}
          {totalAba > LIMITE && (
            <div className="border-t border-slate-100 px-4 py-2.5 text-sm text-slate-600">
              Mostrando {LIMITE} de {totalAba}.{" "}
              <Link href={verTodos} className="font-medium text-marca-700 hover:underline">
                Ver todos
              </Link>
            </div>
          )}
        </Cartao>
      </div>
    </>
  );
}
