import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Campo, Cabecalho, Cartao, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { calcularImpostosMedicao, TAXA_IMPOSTO_DEVIDO } from "@/lib/impostos-medicao";
import { data, moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { anexarNotaMedicao } from "./actions";

export const metadata: Metadata = { title: "Notas de medição" };

const pct = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

export default async function NotasMedicaoPage() {
  await exigirPerfil("financeiro", "suprimentos");
  const supabase = await createClient();
  const [{ data: notas }, { data: obras }] = await Promise.all([
    supabase
      .from("notas_medicao")
      .select("id, nome_arquivo, numero, prestador_nome, prestador_documento, data_emissao, valor, valor_liquido, descricao, obra:obras(nome)")
      .order("criada_em", { ascending: false })
      .limit(500),
    supabase.from("obras").select("id, nome").order("nome"),
  ]);

  const linhas = (notas ?? []).map((n) => ({ n, calc: calcularImpostosMedicao(Number(n.valor), Number(n.valor_liquido)) }));
  const calculadas = linhas.flatMap((l) => (l.calc ? [l.calc] : []));
  const totalValor = calculadas.reduce((s, c) => s + c.total, 0);
  const totalRetido = calculadas.reduce((s, c) => s + c.retido, 0);
  const totalDevido = calculadas.reduce((s, c) => s + c.devido, 0);

  return (
    <>
      <Cabecalho
        titulo="Notas de medição"
        subtitulo="Notas emitidas pela empresa para recebimento. Não são pagamentos: o cálculo mostra o imposto retido pelo cliente e o imposto devido."
      />

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-3">
        <Cartao titulo="Anexar nota de medição" className="2xl:col-span-1">
          <FormAcao action={anexarNotaMedicao} enviar="Anexar nota" pendente="Anexando…" limparAoConcluir>
            <Campo rotulo="Centro de custo" obrigatorio>
              <select name="obra_id" required className="campo" defaultValue="">
                <option value="">Selecione…</option>
                {(obras ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.nome}</option>
                ))}
              </select>
            </Campo>
            <Campo rotulo="Arquivo da nota" obrigatorio ajuda="PDF, XML, PNG ou JPG. Em NFS-e legível, número e prestador são lidos do arquivo.">
              <input type="file" name="arquivo" required accept=".pdf,.xml,.png,.jpg,.jpeg" className="campo" />
            </Campo>
            <div className="grid grid-cols-2 gap-3">
              <Campo rotulo="Valor total (R$)" obrigatorio>
                <input name="valor" required inputMode="decimal" className="campo" placeholder="0,00" />
              </Campo>
              <Campo rotulo="Valor líquido (R$)" obrigatorio ajuda="Valor que a empresa recebe.">
                <input name="valor_liquido" required inputMode="decimal" className="campo" placeholder="0,00" />
              </Campo>
            </div>
            <Campo rotulo="Número da nota" ajuda="Opcional se a nota for legível.">
              <input name="numero" className="campo" maxLength={20} />
            </Campo>
            <Campo rotulo="Observações">
              <input name="descricao" className="campo" maxLength={300} placeholder="Ex.: Boletim de medição 03" />
            </Campo>
          </FormAcao>
        </Cartao>

        <div className="min-w-0 space-y-6 2xl:col-span-2">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Cartao titulo="Notas"><p className="text-xl font-semibold tabular-nums">{notas?.length ?? 0}</p></Cartao>
            <Cartao titulo="Valor total"><p className="text-lg font-semibold whitespace-nowrap tabular-nums">{moeda(totalValor)}</p></Cartao>
            <Cartao titulo="Imposto retido">
              <p className="text-lg font-semibold whitespace-nowrap tabular-nums">{moeda(totalRetido)}</p>
              <p className="text-xs text-slate-500">{totalValor ? pct((totalRetido / totalValor) * 100) : "—"}</p>
            </Cartao>
            <Cartao titulo={`Imposto devido (${Math.round(TAXA_IMPOSTO_DEVIDO * 100)}%)`}>
              <p className={`text-lg font-semibold whitespace-nowrap tabular-nums ${totalDevido < 0 ? "text-red-600" : ""}`}>{moeda(totalDevido)}</p>
              <p className="text-xs text-slate-500">{totalValor ? pct((totalDevido / totalValor) * 100) : "—"}</p>
            </Cartao>
          </div>

          <Cartao titulo={`Notas de medição (${linhas.length})`} semPadding>
            {!linhas.length ? (
              <Vazio>Nenhuma nota de medição anexada ainda.</Vazio>
            ) : (
              <div className="overflow-x-auto">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Nº</th>
                      <th>Obra</th>
                      <th>Arquivo</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Líquido</th>
                      <th className="text-right">Retido</th>
                      <th className="text-right">Devido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map(({ n, calc }) => (
                      <tr key={n.id}>
                        <td className="whitespace-nowrap">
                          {n.numero ?? "—"}
                          {n.data_emissao && <div className="text-xs text-slate-500">{data(n.data_emissao)}</div>}
                        </td>
                        <td className="text-xs">{n.obra?.nome}</td>
                        <td className="min-w-48 text-xs">
                          <div className="font-medium text-slate-800">{n.nome_arquivo}</div>
                          {n.prestador_nome && <div className="text-slate-500">{n.prestador_nome}</div>}
                          {n.descricao && <div className="text-slate-500">{n.descricao}</div>}
                        </td>
                        <td className="text-right whitespace-nowrap tabular-nums">{moeda(Number(n.valor))}</td>
                        <td className="text-right whitespace-nowrap tabular-nums">{moeda(Number(n.valor_liquido))}</td>
                        {calc ? (
                          <>
                            <td className="text-right whitespace-nowrap tabular-nums">{moeda(calc.retido)}<div className="text-xs text-slate-500">{pct(calc.percRetido)}</div></td>
                            <td className={`text-right whitespace-nowrap tabular-nums ${calc.devido < 0 ? "text-red-600" : ""}`}>{moeda(calc.devido)}<div className="text-xs text-slate-500">{pct(calc.percDevido)}</div></td>
                          </>
                        ) : (
                          <td colSpan={2} className="text-xs text-slate-500">Valores inválidos.</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Cartao>
          <p className="text-xs text-slate-500">Valores negativos em vermelho indicam retenção acima de {Math.round(TAXA_IMPOSTO_DEVIDO * 100)}% da nota.</p>
        </div>
      </div>
    </>
  );
}
