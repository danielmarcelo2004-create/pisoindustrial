"use client";

import { useState } from "react";
import { Aviso, Botao, Cartao, Selo, Vazio } from "@/components/ui";
import { contarPaginas, criarOcr, lerPaginaNota, lerTexto, renderizarPagina } from "@/lib/ocr/comprovantes";
import { lerNotaTexto, type NotaLidaOcr } from "@/lib/ocr/nota-fiscal";
import { registrarNotaLida } from "./actions";

type Pendente = { id: string; arquivo: string; mime: string; numero: string | null; favorecido: string; obra: string };
type Resultado = { status: "aguardando" | "lendo" | "registrada" | "nao_lida" | "erro"; detalhe: string };

export function FormLerNotas({ pendentes }: { pendentes: Pendente[] }) {
  const [resultados, setResultados] = useState<Record<string, Resultado>>({});
  const [rodando, setRodando] = useState(false);

  const marcar = (id: string, r: Resultado) => setResultados((s) => ({ ...s, [id]: r }));

  /** Texto da nota: PDF (todas as páginas) ou imagem. */
  async function textoDoDocumento(doc: Pendente, worker: Awaited<ReturnType<typeof criarOcr>>) {
    const resp = await fetch(`/documentos/${doc.id}`, { redirect: "follow" });
    if (!resp.ok) throw new Error("não foi possível abrir o arquivo");
    const blob = await resp.blob();
    const arquivo = new File([blob], doc.arquivo, { type: doc.mime || blob.type });
    if (arquivo.type === "application/pdf") {
      const total = await contarPaginas(arquivo);
      let texto = "";
      for (let n = 1; n <= total; n++) {
        texto += "\n" + (await lerPaginaNota(worker, await renderizarPagina(arquivo, n, 4)));
      }
      return texto;
    }
    const url = URL.createObjectURL(arquivo);
    try {
      return await lerPaginaNota(worker, url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function lerTodas() {
    setRodando(true);
    const worker = await criarOcr();
    try {
      for (const doc of pendentes) {
        marcar(doc.id, { status: "lendo", detalhe: "Lendo…" });
        try {
          const texto = await textoDoDocumento(doc, worker);
          const lida: NotaLidaOcr = lerNotaTexto(texto);
          if (!lida.confiavel) {
            marcar(doc.id, { status: "nao_lida", detalhe: lida.motivos.join("; ") });
            continue;
          }
          const r = await registrarNotaLida(doc.id, { nota: lida.nota, itens: lida.itens });
          if (r?.erro) marcar(doc.id, { status: "erro", detalhe: r.erro });
          else marcar(doc.id, { status: "registrada", detalhe: `${lida.itens.length} item(ns) registrados` });
        } catch (e) {
          marcar(doc.id, { status: "erro", detalhe: (e as Error).message });
        }
      }
    } finally {
      await worker.terminate();
      setRodando(false);
    }
  }

  const contagem = (s: Resultado["status"]) => Object.values(resultados).filter((r) => r.status === s).length;

  return (
    <div className="space-y-6">
      <Cartao titulo={`Notas sem leitura (${pendentes.length})`} acoes={<Botao onClick={lerTodas} disabled={rodando || pendentes.length === 0}>{rodando ? "Lendo…" : "Ler todas"}</Botao>} semPadding>
        {pendentes.length === 0 ? (
          <Vazio>Todas as notas anexadas em PDF ou imagem já foram lidas ou registradas.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Pagamento</th>
                <th>Centro de custo</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {pendentes.map((d) => {
                const r = resultados[d.id];
                return (
                  <tr key={d.id}>
                    <td className="min-w-48">
                      <a href={`/documentos/${d.id}`} target="_blank" rel="noopener" className="text-marca-700 hover:underline">{d.arquivo}</a>
                    </td>
                    <td>
                      {d.numero ? `nº ${d.numero}` : "—"} <span className="text-slate-500">{d.favorecido}</span>
                    </td>
                    <td>{d.obra}</td>
                    <td className="min-w-64 text-xs">
                      {!r && <span className="text-slate-400">Aguardando</span>}
                      {r?.status === "lendo" && <span>Lendo…</span>}
                      {r?.status === "registrada" && <Selo cor="verde">Registrada: {r.detalhe}</Selo>}
                      {r?.status === "nao_lida" && <Selo cor="amarelo">Não entrou: {r.detalhe}</Selo>}
                      {r?.status === "erro" && <Selo cor="vermelho">Erro: {r.detalhe}</Selo>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Cartao>
      {Object.keys(resultados).length > 0 && (
        <Aviso tipo="info">
          Resumo: {contagem("registrada")} registrada(s), {contagem("nao_lida")} fora por leitura duvidosa, {contagem("erro")} com erro.
        </Aviso>
      )}
    </div>
  );
}
