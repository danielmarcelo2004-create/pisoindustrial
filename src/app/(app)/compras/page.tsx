import type { Metadata } from "next";
import Link from "next/link";
import { GraficoBarras, rotuloMes } from "@/components/grafico-barras";
import { Aviso, Cabecalho, Cartao, Indicador, Selo, Vazio, classeBotao, cx } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import {
  agruparMateriais,
  alertasPreco,
  chaveMaterial,
  evolucaoMensal,
  itensCompras,
  LIMIAR_ALERTA,
  porFornecedor,
  porRegiao,
  type FiltrosCompras,
} from "@/lib/consultas/compras";
import { cpfCnpj, data, moeda } from "@/lib/formato";
import { UFS } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Inteligência de Compras" };

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
const preco = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: v < 10 ? 4 : 2 });
const qtd = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

export default async function ComprasPage({ searchParams }: PageProps<"/compras">) {
  await exigirPerfil("financeiro", "suprimentos", "administrador", "administrador_master");
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const filtros: FiltrosCompras = {
    material: s("material"),
    fornecedor: s("fornecedor"),
    obra: s("obra"),
    cidade: s("cidade"),
    uf: s("uf"),
    de: s("de"),
    ate: s("ate"),
  };
  const grupoSel = s("grupo");

  const supabase = await createClient();
  const [todos, { data: obras }] = await Promise.all([itensCompras(filtros), supabase.from("obras").select("id, nome").order("nome")]);
  const itens = grupoSel ? todos.filter((i) => chaveMaterial(i) === grupoSel) : todos;
  const grupos = agruparMateriais(todos);
  const alertas = alertasPreco(todos, grupos);
  const fornecedores = porFornecedor(itens);
  const qs = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v) as [string, string][]);
  const linkGrupo = (k: string) => {
    const q = new URLSearchParams(qs);
    q.set("grupo", k);
    return `/compras?${q}`;
  };
  const grupo = grupoSel ? grupos.find((g) => g.chave === grupoSel) : null;
  const notas = new Set(itens.map((i) => i.nota_id)).size;

  return (
    <>
      <Cabecalho
        titulo="Inteligência de Compras"
        subtitulo="Análise dos preços extraídos das notas fiscais já anexadas aos pagamentos"
        acoes={
          <div className="flex flex-wrap gap-2">
            <Link href="/compras/ler-notas" className={classeBotao("secundario")}>
              Ler notas (PDF)
            </Link>
            <a href={`/compras/exportar?${qs}`} className={classeBotao("secundario")}>
              Exportar para Excel
            </a>
          </div>
        }
      />

      <Cartao className="mb-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="material" defaultValue={filtros.material} placeholder="Material / produto" className="campo" />
          <input name="fornecedor" defaultValue={filtros.fornecedor} placeholder="Fornecedor ou CNPJ" className="campo" />
          <select name="obra" defaultValue={filtros.obra} className="campo">
            <option value="">Todas as obras</option>
            {(obras ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input name="cidade" defaultValue={filtros.cidade} placeholder="Cidade" className="campo" />
            <select name="uf" defaultValue={filtros.uf} className="campo w-24" aria-label="UF">
              <option value="">UF</option>
              {UFS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 lg:col-span-2">
            <input type="date" name="de" defaultValue={filtros.de} className="campo" aria-label="Emissão de" />
            <span className="text-slate-400">a</span>
            <input type="date" name="ate" defaultValue={filtros.ate} className="campo" aria-label="Emissão até" />
          </div>
          <div className="flex gap-2 lg:col-span-2">
            <button className={classeBotao("primario", "sm")}>Filtrar</button>
            <Link href="/compras" className={classeBotao("fantasma", "sm")}>
              Limpar
            </Link>
          </div>
        </form>
      </Cartao>

      <div className="mb-4">
        <Aviso tipo="info">
          As comparações agrupam itens pela descrição e unidade. Descrições parecidas não comprovam equivalência técnica: confira
          marca, especificação, quantidade, frete, impostos, data e condições comerciais. Alertas são indicadores para análise, não
          prova de sobrepreço.
        </Aviso>
      </div>

      {todos.length === 0 ? (
        <Cartao>
          <Vazio>
            Nenhum item de nota fiscal encontrado. Os dados entram automaticamente quando um XML de NF-e é anexado a um pagamento,
            ou pelo lançamento manual dos itens de uma NF em PDF/imagem (no detalhe do pagamento).
          </Vazio>
        </Cartao>
      ) : grupo ? (
        <DetalheMaterial grupo={grupo} itens={itens} voltar={`/compras?${qs}`} fornecedores={fornecedores} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador rotulo="Valor em notas" valor={moeda(itens.reduce((s, i) => s + i.valor_total, 0))} />
            <Indicador rotulo="Notas fiscais" valor={notas} detalhe={`${itens.length} itens`} cor="azul" />
            <Indicador rotulo="Materiais distintos" valor={grupos.length} cor="verde" />
            <Indicador rotulo="Alertas de preço" valor={alertas.length} detalhe={`acima de ${LIMIAR_ALERTA * 100}% da mediana`} cor="amarelo" />
          </div>

          <div className="space-y-6">
            <Cartao titulo="Comparação de preços por material" semPadding>
              <div className="overflow-x-auto">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Un</th>
                      <th className="text-right">Compras</th>
                      <th className="text-right">Quantidade</th>
                      <th className="text-right">Menor</th>
                      <th className="text-right">Médio</th>
                      <th className="text-right">Maior</th>
                      <th className="text-right">Variação</th>
                      <th className="text-right">Último</th>
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupos.slice(0, 200).map((g) => (
                      <tr key={g.chave}>
                        <td className="min-w-60">
                          <Link href={linkGrupo(g.chave)} className="font-medium text-marca-700 hover:underline">
                            {g.descricao}
                          </Link>
                          <div className="text-xs text-slate-500">
                            {g.fornecedores} fornecedor(es) · {g.locais} local(is)
                          </div>
                        </td>
                        <td>{g.unidade}</td>
                        <td className="text-right tabular-nums">{g.compras}</td>
                        <td className="text-right tabular-nums">{qtd(g.quantidade)}</td>
                        <td className="text-right tabular-nums">{preco(g.precoMin)}</td>
                        <td className="text-right tabular-nums">{preco(g.precoMedio)}</td>
                        <td className="text-right tabular-nums">{preco(g.precoMax)}</td>
                        <td className={cx("text-right tabular-nums", g.variacao > LIMIAR_ALERTA && "font-semibold text-amber-700")}>
                          {g.compras > 1 ? pct(g.variacao) : "—"}
                        </td>
                        <td className="text-right whitespace-nowrap tabular-nums">
                          {preco(g.ultimoPreco)}
                          <div className="text-xs text-slate-500">{data(g.ultimaData)}</div>
                        </td>
                        <td className="text-right font-medium tabular-nums">{moeda(g.valorTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Cartao>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Cartao titulo={`Alertas de diferença de preço (${alertas.length})`} semPadding>
                {alertas.length === 0 ? (
                  <Vazio>Nenhum preço acima de {LIMIAR_ALERTA * 100}% da mediana (materiais com 3 ou mais compras).</Vazio>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tabela">
                      <thead>
                        <tr>
                          <th>Material / fornecedor</th>
                          <th className="text-right">Preço</th>
                          <th className="text-right">Mediana</th>
                          <th className="text-right">Diferença</th>
                        </tr>
                      </thead>
                      <tbody>
                        {alertas.slice(0, 30).map((a) => (
                          <tr key={a.item.id}>
                            <td>
                              <Link href={linkGrupo(chaveMaterial(a.item))} className="font-medium text-marca-700 hover:underline">
                                {a.item.descricao}
                              </Link>
                              <div className="text-xs text-slate-500">
                                {a.item.fornecedor_nome} · {a.item.obra_nome} · {data(a.item.data_emissao)}
                              </div>
                            </td>
                            <td className="text-right tabular-nums">{preco(a.item.valor_unitario)}</td>
                            <td className="text-right tabular-nums">{preco(a.mediana)}</td>
                            <td className="text-right">
                              <Selo cor="amarelo">{pct(a.diferenca)}</Selo>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Cartao>

              <Cartao titulo="Fornecedores por valor comprado" semPadding>
                <div className="overflow-x-auto">
                  <table className="tabela">
                    <thead>
                      <tr>
                        <th>Fornecedor</th>
                        <th className="text-right">Notas</th>
                        <th className="text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fornecedores.slice(0, 15).map((f) => (
                        <tr key={f.cnpj ?? f.nome}>
                          <td>
                            {f.nome}
                            {f.cnpj && <div className="text-xs text-slate-500">{cpfCnpj(f.cnpj)}</div>}
                          </td>
                          <td className="text-right tabular-nums">{f.notas}</td>
                          <td className="text-right font-medium tabular-nums">{moeda(f.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Cartao>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function DetalheMaterial({
  grupo,
  itens,
  voltar,
  fornecedores,
}: {
  grupo: ReturnType<typeof agruparMateriais>[number];
  itens: Awaited<ReturnType<typeof itensCompras>>;
  voltar: string;
  fornecedores: ReturnType<typeof porFornecedor>;
}) {
  const meses = evolucaoMensal(itens);
  const regioes = porRegiao(itens);
  return (
    <>
      <Link href={voltar} className="mb-3 inline-block text-sm text-marca-600 hover:underline">
        ← Todos os materiais
      </Link>
      <h2 className="mb-4 text-lg font-semibold">
        {grupo.descricao} <span className="font-normal text-slate-500">({grupo.unidade ?? "sem unidade"})</span>
      </h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Indicador rotulo="Menor preço" valor={preco(grupo.precoMin)} cor="verde" />
        <Indicador rotulo="Preço médio" valor={preco(grupo.precoMedio)} detalhe="ponderado pela quantidade" />
        <Indicador rotulo="Maior preço" valor={preco(grupo.precoMax)} cor="vermelho" />
        <Indicador rotulo="Último preço" valor={preco(grupo.ultimoPreco)} detalhe={data(grupo.ultimaData)} cor="azul" />
        <Indicador rotulo="Quantidade" valor={qtd(grupo.quantidade)} detalhe={`${grupo.compras} compra(s)`} cor="amarelo" />
      </div>
      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Cartao titulo="Preço médio por mês">
          <GraficoBarras
            titulo="Preço médio por mês"
            dados={meses.map((m) => ({ rotulo: rotuloMes(m.mes), valor: m.preco, detalhe: `${m.compras} compra(s)` }))}
          />
        </Cartao>
        <Cartao titulo="Comparação regional (preço médio)" semPadding>
          <table className="tabela">
            <thead>
              <tr>
                <th>Cidade/UF</th>
                <th className="text-right">Compras</th>
                <th className="text-right">Preço médio</th>
              </tr>
            </thead>
            <tbody>
              {regioes.map((r) => (
                <tr key={r.local}>
                  <td>{r.local}</td>
                  <td className="text-right tabular-nums">{r.compras}</td>
                  <td className="text-right font-medium tabular-nums">{preco(r.preco)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fornecedores.length > 1 && (
            <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">{fornecedores.length} fornecedores diferentes.</div>
          )}
        </Cartao>
      </div>
      <Cartao titulo="Histórico de compras" semPadding>
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Emissão</th>
                <th>Fornecedor</th>
                <th>Centro de custo</th>
                <th>Local</th>
                <th>Descrição na nota</th>
                <th className="text-right">Qtd</th>
                <th className="text-right">Preço unit.</th>
                <th className="text-right">vs. mediana</th>
                <th>Origem</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((i) => {
                const dif = grupo.precoMediana ? i.valor_unitario / grupo.precoMediana - 1 : 0;
                return (
                  <tr key={i.id}>
                    <td className="whitespace-nowrap tabular-nums">
                      <Link href={`/pagamentos/${i.pagamento_id}`} className="text-marca-700 hover:underline">
                        {data(i.data_emissao)}
                      </Link>
                      {i.nf_numero && <div className="text-xs text-slate-500">NF {i.nf_numero}</div>}
                    </td>
                    <td>{i.fornecedor_nome}</td>
                    <td>{i.obra_nome}</td>
                    <td className="whitespace-nowrap">
                      {i.cidade}/{i.uf}
                    </td>
                    <td className="min-w-48 text-xs">{i.descricao}</td>
                    <td className="text-right tabular-nums">{qtd(i.quantidade)}</td>
                    <td className="text-right font-medium tabular-nums">{preco(i.valor_unitario)}</td>
                    <td className={cx("text-right tabular-nums", dif > LIMIAR_ALERTA && "font-semibold text-amber-700", dif < -LIMIAR_ALERTA && "text-emerald-700")}>
                      {grupo.compras > 1 ? pct(dif) : "—"}
                    </td>
                    <td>
                      <Selo cor={i.origem === "xml" ? "azul" : "cinza"}>{i.origem === "xml" ? "XML" : "Manual"}</Selo>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Cartao>
    </>
  );
}
