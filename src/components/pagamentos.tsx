import Link from "next/link";
import { Selo, Vazio, cx } from "@/components/ui";
import { data, hojeISO, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, STATUS_EM_ABERTO, STATUS_PAGAMENTO, type StatusPagamento } from "@/lib/rotulos";
import type { PagamentoLista } from "@/lib/consultas/pagamentos";

export function SeloStatus({ status }: { status: StatusPagamento }) {
  const s = STATUS_PAGAMENTO[status];
  return <Selo cor={s.cor}>{s.rotulo}</Selo>;
}

export function Vencimento({ iso, status }: { iso: string; status: StatusPagamento }) {
  const hoje = hojeISO();
  const aberto = STATUS_EM_ABERTO.includes(status);
  const vencido = aberto && iso < hoje;
  const ehHoje = aberto && iso === hoje;
  return (
    <span className={cx("tabular-nums", vencido && "font-semibold text-red-700", ehHoje && "font-semibold text-amber-700")}>
      {data(iso)}
      {vencido && <span className="ml-1 text-xs font-normal">(vencido)</span>}
      {ehHoje && <span className="ml-1 text-xs font-normal">(hoje)</span>}
    </span>
  );
}

export function TabelaPagamentos({
  itens,
  vazio = "Nenhum pagamento encontrado.",
  semObra,
  compacto,
}: {
  itens: PagamentoLista[];
  vazio?: string;
  semObra?: boolean;
  /** Mostra a obra abaixo da descrição (para cartões estreitos). */
  compacto?: boolean;
}) {
  const colunaObra = !semObra && !compacto;
  if (itens.length === 0) return <Vazio>{vazio}</Vazio>;
  return (
    <div className="overflow-x-auto">
      <table className="tabela">
        <thead>
          <tr>
            <th className="w-16">Nº</th>
            <th>Vencimento</th>
            <th>Favorecido / descrição</th>
            {colunaObra && <th>Centro de custo</th>}
            <th className="text-right">Valor</th>
            {!compacto && <th>Forma</th>}
            <th>Situação</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((p) => (
            <tr key={p.id}>
              <td className="text-slate-500 tabular-nums">
                <Link href={`/pagamentos/${p.id}`} className="hover:underline">
                  {p.numero}
                </Link>
              </td>
              <td className="whitespace-nowrap">
                <Vencimento iso={p.vencimento} status={p.status} />
              </td>
              <td className="min-w-56">
                <Link href={`/pagamentos/${p.id}`} className="font-medium text-marca-700 hover:underline">
                  {p.favorecido}
                </Link>
                <div className="line-clamp-1 text-xs text-slate-500">{p.descricao}</div>
                {compacto && !semObra && <div className="text-xs text-slate-400">{p.obra?.nome}</div>}
              </td>
              {colunaObra && <td className="min-w-40 text-slate-700">{p.obra?.nome}</td>}
              <td className="text-right font-medium whitespace-nowrap tabular-nums">{moeda(p.valor)}</td>
              {!compacto && <td className="whitespace-nowrap text-slate-700">{FORMAS_PAGAMENTO[p.forma_pagamento]}</td>}
              <td>
                <SeloStatus status={p.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
