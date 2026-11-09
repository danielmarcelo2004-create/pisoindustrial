import type { Metadata } from "next";
import Link from "next/link";
import { Cabecalho, Cartao, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { listarNotasMedicao } from "@/lib/consultas/notas-contabeis";
import { calcularImpostosMedicao, TAXA_IMPOSTO_DEVIDO } from "@/lib/impostos-medicao";
import { data, moeda } from "@/lib/formato";

export const metadata: Metadata = { title: "Notas de medição" };

const pct = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

export default async function ImpostosMedicaoPage() {
  await exigirPerfil("financeiro");
  const medicoes = await listarNotasMedicao();

  const linhas = medicoes.map((n) => ({ n, calc: calcularImpostosMedicao(n.valor, n.valor_liquido) }));
  const calculadas = linhas.flatMap((l) => (l.calc ? [l.calc] : []));
  const soma = (f: (c: NonNullable<(typeof calculadas)[number]>) => number) => calculadas.reduce((s, c) => s + f(c), 0);
  const totalValor = soma((c) => c.total);
  const totalRetido = soma((c) => c.retido);
  const totalDevido = soma((c) => c.devido);

  return (
    <>
      <Cabecalho
        titulo="Notas de medição"
        subtitulo={`Imposto retido = valor total − valor líquido. Imposto devido = ${TAXA_IMPOSTO_DEVIDO * 100}% do valor total − imposto retido. Os percentuais são sobre o valor total da nota.`}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Cartao titulo="Medições com cálculo"><p className="text-xl font-semibold tabular-nums">{calculadas.length}</p></Cartao>
        <Cartao titulo="Valor total"><p className="text-xl font-semibold tabular-nums">{moeda(totalValor)}</p></Cartao>
        <Cartao titulo="Imposto retido">
          <p className="text-xl font-semibold tabular-nums">{moeda(totalRetido)}</p>
          <p className="text-xs text-slate-500">{totalValor ? pct((totalRetido / totalValor) * 100) : "—"} do total</p>
        </Cartao>
        <Cartao titulo="Imposto devido">
          <p className="text-xl font-semibold tabular-nums">{moeda(totalDevido)}</p>
          <p className="text-xs text-slate-500">{totalValor ? pct((totalDevido / totalValor) * 100) : "—"} do total</p>
        </Cartao>
      </div>

      <div className="mt-6">
        <Cartao titulo={`Medições (${medicoes.length})`} semPadding>
          {!medicoes.length ? (
            <Vazio>Nenhuma nota de medição foi identificada ainda. As notas entram aqui quando são anexadas a um pagamento.</Vazio>
          ) : (
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Emissão</th>
                    <th>Nº</th>
                    <th>Obra · pagamento</th>
                    <th className="text-right">Valor total</th>
                    <th className="text-right">Valor líquido</th>
                    <th className="text-right">Imposto retido</th>
                    <th className="text-right">% retido</th>
                    <th className="text-right">Imposto devido (14%)</th>
                    <th className="text-right">% devido</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map(({ n, calc }) => (
                    <tr key={n.id}>
                      <td className="whitespace-nowrap tabular-nums">{n.data_emissao ? data(n.data_emissao) : "—"}</td>
                      <td className="whitespace-nowrap">{n.numero ?? "—"}</td>
                      <td className="min-w-48 text-xs">
                        <div>{n.obra?.nome}</div>
                        {n.pagamento && (
                          <Link href={`/pagamentos/${n.pagamento.id}`} className="text-marca-700 hover:underline">{n.pagamento.descricao}</Link>
                        )}
                      </td>
                      {calc ? (
                        <>
                          <td className="text-right tabular-nums">{moeda(calc.total)}</td>
                          <td className="text-right tabular-nums">{moeda(calc.liquido)}</td>
                          <td className="text-right tabular-nums">{moeda(calc.retido)}</td>
                          <td className="text-right tabular-nums">{pct(calc.percRetido)}</td>
                          <td className={`text-right tabular-nums ${calc.devido < 0 ? "text-red-600" : ""}`}>{moeda(calc.devido)}</td>
                          <td className={`text-right tabular-nums ${calc.devido < 0 ? "text-red-600" : ""}`}>{pct(calc.percDevido)}</td>
                        </>
                      ) : (
                        <td colSpan={6} className="text-xs text-slate-500">Valor líquido não encontrado na nota: confira o documento.</td>
                      )}
                    </tr>
                  ))}
                  {calculadas.length > 0 && (
                    <tr className="font-semibold">
                      <td colSpan={3}>Totais</td>
                      <td className="text-right tabular-nums">{moeda(totalValor)}</td>
                      <td className="text-right tabular-nums">{moeda(soma((c) => c.liquido))}</td>
                      <td className="text-right tabular-nums">{moeda(totalRetido)}</td>
                      <td className="text-right tabular-nums">{totalValor ? pct((totalRetido / totalValor) * 100) : "—"}</td>
                      <td className="text-right tabular-nums">{moeda(totalDevido)}</td>
                      <td className="text-right tabular-nums">{totalValor ? pct((totalDevido / totalValor) * 100) : "—"}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Cartao>
      </div>
      <p className="mt-4 text-xs text-slate-500">Valores negativos em vermelho indicam que a retenção já passou dos 14% da nota.</p>
      
    </>
  );
}
