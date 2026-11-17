"use client";

import { startTransition, useActionState, useMemo, useState } from "react";
import { Aviso, Botao, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { data as formatarData, moeda } from "@/lib/formato";
import { chaveComprovante, lerComprovante, sugerirCasamentos, type Aberto, type Comprovante, type Confianca } from "@/lib/comprovantes-banco";
import { criarOcr, extrairPagina, lerTextoPaginas } from "@/lib/ocr/comprovantes";
import { registrarBaixasLote } from "./actions";

type Pagina = {
  id: string;
  arquivo: File;
  nomeArquivo: string;
  pagina: number;
  comprovante: Comprovante;
  /** Página repetida (mesmo comprovante já lido em outra página/arquivo). */
  repetidaDe: string | null;
  escolha: string;
  confianca: Confianca;
  motivo: string;
  valorDiferente: boolean;
  data: string;
};

const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const COR: Record<Confianca, "verde" | "azul" | "amarelo" | "vermelho" | "cinza"> = { alta: "verde", media: "azul", baixa: "amarelo", ambigua: "amarelo", nenhuma: "cinza" };
const ROTULO: Record<Confianca, string> = { alta: "Reconhecido", media: "Só pelo valor", baixa: "Confira", ambigua: "Escolha", nenhuma: "Sem pagamento" };

export function FormBaixaLote({ abertos }: { abertos: Aberto[] }) {
  const [estado, acao] = useActionState(registrarBaixasLote, null);
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [paginas, setPaginas] = useState<Pagina[]>([]);
  const [progresso, setProgresso] = useState("");
  const [lendo, setLendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState("");
  const [semComprovante, setSemComprovante] = useState<Set<string>>(new Set());
  const [dataSemComprovante, setDataSemComprovante] = useState(hoje());

  const porChave = useMemo(() => new Map(abertos.map((a) => [a.chave, a])), [abertos]);
  const validas = paginas.filter((p) => !p.repetidaDe);
  const escolhidas = validas.filter((p) => p.escolha);
  const usadosPorComprovante = new Set(escolhidas.map((p) => p.escolha));
  const restantes = abertos.filter((a) => !usadosPorComprovante.has(a.chave));
  const repetidosEscolhidos = escolhidas.map((p) => p.escolha).filter((c, i, a) => a.indexOf(c) !== i);

  async function lerComprovantes() {
    if (!arquivos.length) return setErroLocal("Escolha o(s) PDF(s) com os comprovantes.");
    setErroLocal("");
    setLendo(true);
    setPaginas([]);
    let worker: Awaited<ReturnType<typeof criarOcr>> | null = null;
    try {
      const lidas: Omit<Pagina, "escolha" | "confianca" | "motivo" | "valorDiferente">[] = [];
      const vistos = new Map<string, string>();
      for (const arq of arquivos) {
        const textos = await lerTextoPaginas(arq, async (n, total) => {
          setProgresso(`Lendo ${arq.name}: página ${n} de ${total}…`);
          if (!worker) worker = await criarOcr();
          return worker;
        });
        textos.forEach((texto, i) => {
          const comprovante = lerComprovante(texto);
          const id = `${arq.name}#${i + 1}`;
          const chave = chaveComprovante(comprovante);
          const repetidaDe = chave && vistos.has(chave) ? vistos.get(chave)! : null;
          if (chave && !repetidaDe) vistos.set(chave, `${arq.name}, página ${i + 1}`);
          lidas.push({ id, arquivo: arq, nomeArquivo: arq.name, pagina: i + 1, comprovante, repetidaDe, data: comprovante.data ?? hoje() });
        });
      }
      const unicas = lidas.filter((p) => !p.repetidaDe);
      const sugestoes = sugerirCasamentos(unicas.map((p) => p.comprovante), abertos);
      const porId = new Map(unicas.map((p, i) => [p.id, sugestoes[i]]));
      setPaginas(
        lidas.map((p) => {
          const s = porId.get(p.id);
          return { ...p, escolha: s?.chave ?? "", confianca: s?.confianca ?? "nenhuma", motivo: s?.motivo ?? "", valorDiferente: s?.valorDiferente ?? false };
        }),
      );
      const reconhecidos = sugestoes.filter((s) => s.chave).length;
      const repetidas = lidas.length - unicas.length;
      setProgresso(
        `${lidas.length} página(s) lidas: ${unicas.length} comprovante(s)${repetidas ? `, ${repetidas} repetida(s) ignorada(s)` : ""}. ${reconhecidos} reconhecido(s) automaticamente. Confira abaixo.`,
      );
    } catch (e) {
      setErroLocal(`Não foi possível ler o PDF: ${(e as Error).message}`);
    } finally {
      if (worker) await (worker as { terminate: () => Promise<unknown> }).terminate();
      setLendo(false);
    }
  }

  const alterar = (id: string, campo: "escolha" | "data", valor: string) =>
    setPaginas((ps) => ps.map((p) => (p.id === id ? { ...p, [campo]: valor, ...(campo === "escolha" ? { confianca: valor ? ("alta" as Confianca) : ("nenhuma" as Confianca), motivo: valor ? "Escolhido por você." : "", valorDiferente: !!valor && p.comprovante.valor !== null && Math.abs((porChave.get(valor)?.valor ?? 0) - p.comprovante.valor) >= 0.005 } : {}) } : p)));

  async function confirmar() {
    if (repetidosEscolhidos.length) return setErroLocal("Um mesmo pagamento foi escolhido para dois comprovantes. Corrija antes de confirmar.");
    const sem = [...semComprovante].filter((c) => !usadosPorComprovante.has(c));
    if (!escolhidas.length && !sem.length) return setErroLocal("Nenhum pagamento escolhido para a baixa.");
    setErroLocal("");
    setEnviando(true);
    try {
      const fd = new FormData();
      const itens: { chave: string; pago_em: string; valor: number | null; arquivo?: string }[] = [];
      for (const [i, p] of escolhidas.entries()) {
        const a = porChave.get(p.escolha);
        const nome = `comprovante-${a?.numero ?? "pagamento"}${a?.tipo === "parcela" ? "-parcela" : ""}.pdf`;
        fd.append(`arq_${i}`, await extrairPagina(p.arquivo, p.pagina, nome));
        itens.push({ chave: p.escolha, pago_em: p.data, valor: p.comprovante.valor, arquivo: `arq_${i}` });
      }
      for (const c of sem) itens.push({ chave: c, pago_em: dataSemComprovante, valor: null });
      fd.set("itens", JSON.stringify(itens));
      startTransition(() => acao(fd));
      setPaginas([]);
      setSemComprovante(new Set());
      setArquivos([]);
      setProgresso("");
    } finally {
      setEnviando(false);
    }
  }

  const total = escolhidas.length + [...semComprovante].filter((c) => !usadosPorComprovante.has(c)).length;

  return (
    <div className="space-y-6">
      {estado?.ok && <Aviso tipo="sucesso">{estado.ok}</Aviso>}
      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
      {erroLocal && <Aviso tipo="erro">{erroLocal}</Aviso>}

      <Cartao titulo="1. Comprovantes do banco">
        {abertos.length === 0 ? (
          <Vazio>Nenhum pagamento liberado para pagamento agora.</Vazio>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600">
              {abertos.length} pagamento(s)/parcela(s) liberados para pagamento. Envie um ou mais PDFs (por exemplo, o de PIX e o de boletos do dia):
              cada página é um comprovante. Páginas repetidas entre os arquivos são ignoradas.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Campo rotulo="PDF(s) com os comprovantes" ajuda="A leitura acontece no seu navegador e leva alguns segundos por página.">
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple
                    className="campo"
                    aria-label="PDFs dos comprovantes"
                    onChange={(e) => {
                      setArquivos(Array.from(e.target.files ?? []));
                      setPaginas([]);
                      setProgresso("");
                    }}
                  />
                </Campo>
              </div>
              <Botao type="button" onClick={lerComprovantes} disabled={lendo || !arquivos.length}>
                {lendo ? "Lendo…" : "Ler comprovantes"}
              </Botao>
            </div>
            {progresso && <p className="mt-3 text-sm text-slate-700" role="status">{progresso}</p>}
          </>
        )}
      </Cartao>

      {paginas.length > 0 && (
        <Cartao titulo="2. Conferência" semPadding>
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Comprovante</th>
                  <th className="text-right">Valor</th>
                  <th>Pago para</th>
                  <th>Data</th>
                  <th className="min-w-80">Pagamento</th>
                </tr>
              </thead>
              <tbody>
                {paginas.map((p) => {
                  const c = p.comprovante;
                  const escolhido = porChave.get(p.escolha);
                  return (
                    <tr key={p.id} className={p.repetidaDe ? "bg-slate-50 text-slate-400" : undefined} data-pagina={p.id}>
                      <td className="text-xs whitespace-nowrap">
                        <div className="font-medium text-slate-700">{c.tipo === "pix" ? "PIX" : c.tipo === "boleto" ? "Boleto" : "Outro"}</div>
                        <div>{p.nomeArquivo}</div>
                        <div>página {p.pagina}</div>
                      </td>
                      <td className="text-right tabular-nums">{c.valor === null ? <span className="text-red-700">não lido</span> : moeda(c.valor)}</td>
                      <td className="text-xs">
                        <div className="font-medium text-slate-700">{c.beneficiario ?? <span className="text-red-700">não lido</span>}</div>
                        {c.cnpj && <div>CNPJ {c.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5")}</div>}
                        {c.cpfMeio && <div>CPF ***.{c.cpfMeio.slice(0, 3)}.{c.cpfMeio.slice(3)}-**</div>}
                        {c.chavePix && <div>Chave {c.chavePix}</div>}
                        {c.descricao && <div>“{c.descricao}”</div>}
                      </td>
                      <td>
                        {p.repetidaDe ? (
                          "—"
                        ) : (
                          <input type="date" value={p.data} onChange={(e) => alterar(p.id, "data", e.target.value)} className="campo w-40" aria-label={`Data do pagamento ${p.id}`} />
                        )}
                      </td>
                      <td>
                        {p.repetidaDe ? (
                          <span className="text-xs">Repetida: mesmo comprovante de {p.repetidaDe}. Ignorada.</span>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <select value={p.escolha} onChange={(e) => alterar(p.id, "escolha", e.target.value)} className="campo" aria-label={`Pagamento da ${p.id}`}>
                                <option value="">Não dar baixa</option>
                                {abertos
                                  .filter((a) => a.chave === p.escolha || !usadosPorComprovante.has(a.chave))
                                  .map((a) => (
                                    <option key={a.chave} value={a.chave}>
                                      {a.rotulo}
                                    </option>
                                  ))}
                              </select>
                              <Selo cor={COR[p.confianca]}>{ROTULO[p.confianca]}</Selo>
                            </div>
                            {p.motivo && <div className="mt-1 text-xs text-slate-600">{p.motivo}</div>}
                            {p.valorDiferente && escolhido && c.valor !== null && (
                              <div className="mt-1 text-xs text-amber-700">
                                Comprovante de {moeda(c.valor)} para um pagamento de {moeda(escolhido.valor)}
                                {c.valor < escolhido.valor ? ": a diferença fica como saldo em aberto." : ": a baixa registra o valor pago."}
                              </div>
                            )}
                            {!p.escolha && /fundo\s+fixo/i.test(c.descricao ?? "") && (
                              <div className="mt-1 text-xs text-slate-600">Parece reposição de fundo fixo: registre em Fundos fixos.</div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}

      {abertos.length > 0 && (
        <Cartao titulo={paginas.length ? "3. Pagamentos sem comprovante (opcional)" : "Baixa sem comprovante"} semPadding>
          {restantes.length === 0 ? (
            <Vazio>Todos os pagamentos liberados já têm comprovante escolhido.</Vazio>
          ) : (
            <div className="overflow-x-auto">
              <table className="tabela">
                <tbody>
                  {restantes.map((a) => (
                    <tr key={a.chave}>
                      <td className="w-10">
                        <input
                          type="checkbox"
                          aria-label={`Baixa sem comprovante nº ${a.numero}${a.tipo === "parcela" ? " parcela" : ""}`}
                          checked={semComprovante.has(a.chave)}
                          onChange={() =>
                            setSemComprovante((s) => {
                              const n = new Set(s);
                              if (n.has(a.chave)) n.delete(a.chave);
                              else n.add(a.chave);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="text-sm">{a.rotulo}</td>
                      <td className="text-xs whitespace-nowrap text-slate-500">venc. {formatarData(a.vencimento)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 px-4 py-3 text-sm">
            <div className="w-48">
              <Campo rotulo="Data (sem comprovante)">
                <input type="date" value={dataSemComprovante} onChange={(e) => setDataSemComprovante(e.target.value)} className="campo" />
              </Campo>
            </div>
            <span className="text-xs text-slate-500">Marque só se o pagamento foi feito e o comprovante virá depois (pode anexar na página do pagamento).</span>
          </div>
        </Cartao>
      )}

      {(paginas.length > 0 || semComprovante.size > 0) && (
        <div className="flex flex-wrap items-center gap-3">
          <Botao type="button" onClick={confirmar} disabled={enviando || total === 0} variante="sucesso">
            {enviando ? "Registrando…" : `Registrar ${total} baixa(s)`}
          </Botao>
          <span className="text-sm text-slate-600">
            {escolhidas.length} com comprovante
            {total - escolhidas.length > 0 ? ` · ${total - escolhidas.length} sem comprovante` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
