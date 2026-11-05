"use client";

import { startTransition, useActionState, useState } from "react";
import { Aviso, Botao, Campo, Cartao, Vazio } from "@/components/ui";
import { data as formatarData, moeda } from "@/lib/formato";
import { criarOcr, contarPaginas, extrairCampos, extrairPagina, lerTexto, renderizarPagina, type CampoComprovante } from "@/lib/ocr/comprovantes";
import { registrarBaixasLote } from "./actions";

type Linha = { id: string; numero: number; favorecido: string; descricao: string; valor: number; vencimento: string | null; obra: string; cnpj: string | null };
type Pagina = CampoComprovante & { numero: number; atribuido: string };

const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const SO_NUMEROS = (s: string | null) => (s ?? "").replace(/\D/g, "");

export function FormBaixaLote({ linhas }: { linhas: Linha[] }) {
  const [estado, acao] = useActionState(registrarBaixasLote, null);
  const [pagoEm, setPagoEm] = useState(hoje());
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [paginas, setPaginas] = useState<Pagina[]>([]);
  const [progresso, setProgresso] = useState("");
  const [lendo, setLendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState("");

  const marcados = linhas.filter((l) => selecionados.has(l.id));
  const totalMarcado = marcados.reduce((s, l) => s + l.valor, 0);

  function alternar(id: string) {
    setSelecionados((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  /** Sugere o pagamento de cada página: mesmo valor e, se possível, mesmo CNPJ. */
  function sugerir(lidas: (CampoComprovante & { numero: number })[]): Pagina[] {
    const usados = new Set<string>();
    return lidas.map((pg) => {
      const candidatos = marcados.filter((l) => pg.valor !== null && Math.abs(l.valor - pg.valor) < 0.01);
      const comCnpj = candidatos.filter((l) => pg.cnpj && SO_NUMEROS(l.cnpj) === SO_NUMEROS(pg.cnpj));
      const escolha = [comCnpj, candidatos].find((lista) => lista.length === 1 && !usados.has(lista[0].id));
      const id = escolha ? escolha[0].id : "";
      if (id) usados.add(id);
      return { ...pg, atribuido: id };
    });
  }

  async function lerComprovantes() {
    if (!arquivo) return setErroLocal("Escolha o PDF com os comprovantes.");
    if (marcados.length === 0) return setErroLocal("Marque os pagamentos antes de ler o PDF.");
    setErroLocal("");
    setLendo(true);
    setPaginas([]);
    try {
      const total = await contarPaginas(arquivo);
      const worker = await criarOcr();
      const lidas: (CampoComprovante & { numero: number })[] = [];
      for (let n = 1; n <= total; n++) {
        setProgresso(`Lendo página ${n} de ${total}…`);
        const imagem = await renderizarPagina(arquivo, n);
        const texto = await lerTexto(worker, imagem);
        lidas.push({ numero: n, ...extrairCampos(texto) });
      }
      await worker.terminate();
      setPaginas(sugerir(lidas));
      setProgresso(`${total} página(s) lidas. Confira as ligações abaixo.`);
    } catch (e) {
      setErroLocal(`Não foi possível ler o PDF: ${(e as Error).message}`);
    } finally {
      setLendo(false);
    }
  }

  function trocar(numero: number, id: string) {
    setPaginas((ps) => ps.map((p) => (p.numero === numero ? { ...p, atribuido: id } : p)));
  }

  async function confirmar() {
    const repetidos = paginas.map((p) => p.atribuido).filter((id, i, a) => id && a.indexOf(id) !== i);
    if (repetidos.length) return setErroLocal("Um mesmo pagamento não pode receber dois comprovantes.");
    if (!arquivo) return;
    setErroLocal("");
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.set("pago_em", pagoEm);
      fd.set("ids", JSON.stringify([...selecionados]));
      for (const p of paginas.filter((x) => x.atribuido)) {
        const l = linhas.find((x) => x.id === p.atribuido);
        const nome = `comprovante-${l?.numero ?? "pagamento"}.pdf`;
        fd.append(`comp_${p.atribuido}`, await extrairPagina(arquivo, p.numero, nome));
      }
      startTransition(() => acao(fd));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6">
      {estado?.ok && <Aviso tipo="sucesso">{estado.ok}</Aviso>}
      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
      {erroLocal && <Aviso tipo="erro">{erroLocal}</Aviso>}

      <Cartao titulo="1. Pagamentos liberados" semPadding>
        {linhas.length === 0 ? (
          <Vazio>Nenhum pagamento liberado para pagamento.</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Marcar todos"
                      checked={selecionados.size === linhas.length}
                      onChange={() => setSelecionados(selecionados.size === linhas.length ? new Set() : new Set(linhas.map((l) => l.id)))}
                    />
                  </th>
                  <th>Nº</th>
                  <th>Vencimento</th>
                  <th>Favorecido / descrição</th>
                  <th>Centro de custo</th>
                  <th className="text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input type="checkbox" aria-label={`Selecionar nº ${l.numero}`} checked={selecionados.has(l.id)} onChange={() => alternar(l.id)} />
                    </td>
                    <td className="tabular-nums">{l.numero}</td>
                    <td className="whitespace-nowrap">{formatarData(l.vencimento)}</td>
                    <td>
                      {l.favorecido}
                      <div className="text-xs text-slate-500">{l.descricao}</div>
                    </td>
                    <td>{l.obra}</td>
                    <td className="text-right tabular-nums">{moeda(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm">
          <span>
            {marcados.length} marcado(s) · <strong className="tabular-nums">{moeda(totalMarcado)}</strong>
          </span>
          <div className="w-48">
            <Campo rotulo="Data do pagamento">
              <input type="date" value={pagoEm} onChange={(e) => setPagoEm(e.target.value)} className="campo" />
            </Campo>
          </div>
        </div>
      </Cartao>

      <Cartao titulo="2. Comprovantes do banco (PDF único)">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Campo rotulo="PDF com os comprovantes" ajuda="Cada página é um comprovante. A leitura acontece no seu navegador.">
              <input type="file" accept="application/pdf" className="campo" onChange={(e) => { setArquivo(e.target.files?.[0] ?? null); setPaginas([]); }} />
            </Campo>
          </div>
          <Botao type="button" onClick={lerComprovantes} disabled={lendo || !arquivo}>
            {lendo ? "Lendo…" : "Ler comprovantes"}
          </Botao>
        </div>
        {progresso && <p className="mt-3 text-sm text-slate-600">{progresso}</p>}
      </Cartao>

      {paginas.length > 0 && (
        <Cartao titulo="3. Separação dos comprovantes" semPadding>
          <table className="tabela">
            <thead>
              <tr>
                <th>Página</th>
                <th className="text-right">Valor lido</th>
                <th>Beneficiário (CNPJ lido)</th>
                <th>Pagamento</th>
              </tr>
            </thead>
            <tbody>
              {paginas.map((p) => (
                <tr key={p.numero}>
                  <td className="tabular-nums">{p.numero}</td>
                  <td className="text-right tabular-nums">{p.valor === null ? <span className="text-red-700">não lido</span> : moeda(p.valor)}</td>
                  <td className="text-xs">{p.cnpj ?? <span className="text-red-700">não lido</span>}</td>
                  <td>
                    <select value={p.atribuido} onChange={(e) => trocar(p.numero, e.target.value)} className="campo">
                      <option value="">Não anexar</option>
                      {marcados.map((l) => (
                        <option key={l.id} value={l.id}>
                          nº {l.numero} · {l.favorecido} · {moeda(l.valor)}
                        </option>
                      ))}
                    </select>
                    {p.atribuido === "" && p.valor !== null && <div className="mt-1 text-xs text-amber-700">Sem ligação automática: escolha o pagamento.</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-3">
            <Botao type="button" onClick={confirmar} disabled={enviando || marcados.length === 0} variante="sucesso">
              {enviando ? "Separando e registrando…" : `Registrar ${marcados.length} pagamento(s) e anexar comprovantes`}
            </Botao>
            <span className="text-xs text-slate-500">Os pagamentos marcados sem comprovante também recebem a baixa.</span>
          </div>
        </Cartao>
      )}
    </div>
  );
}
