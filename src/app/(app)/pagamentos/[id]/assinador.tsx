"use client";

import { useRef, useState } from "react";
import type { PDFDocument as PDFDocumento } from "pdf-lib";
import { useRouter } from "next/navigation";
import { Aviso, Botao, Campo, Cartao } from "@/components/ui";
import { renderizarPagina, contarPaginas } from "@/lib/ocr/comprovantes";
import { criarClienteNavegador } from "@/lib/supabase/navegador";

type Doc = { id: string; nome: string; mime: string; tipo?: string };
type Pos = { fx: number; fy: number; fw: number };

async function sha256Hex(bytes: Uint8Array) {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function AssinadorDocumentos({
  documentos,
  assinaturaUrl,
  assinaturaMime,
  pagamentoId,
  obraId,
}: {
  documentos: Doc[];
  assinaturaUrl: string;
  assinaturaMime: "image/png" | "image/jpeg";
  pagamentoId: string;
  obraId: string;
}) {
  const router = useRouter();
  // Começa pela versão assinada mais recente (assim as assinaturas se acumulam no mesmo documento).
  const ultimaAssinada = [...documentos].reverse().find((d) => d.tipo === "documento_assinado");
  const [escolhido, setEscolhido] = useState<Doc | null>(ultimaAssinada ?? documentos[0] ?? null);
  const [aberto, setAberto] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [arquivoOriginal, setArquivoOriginal] = useState<File | null>(null);
  const [pos, setPos] = useState<Pos>({ fx: 0.68, fy: 0.78, fw: 0.24 });
  const [totalPaginas, setTotalPaginas] = useState(1);
  const [paginaEscolhida, setPaginaEscolhida] = useState(1);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");
  const contRef = useRef<HTMLDivElement>(null);
  const arrasto = useRef<{ tipo: "mover" | "redim"; x: number; y: number; pos: Pos } | null>(null);

  async function abrir() {
    if (!escolhido) return;
    setErro("");
    setOk("");
    setOcupado(true);
    try {
      const resp = await fetch(`/documentos/${escolhido.id}`);
      if (!resp.ok) throw new Error("não foi possível abrir o documento");
      const blob = await resp.blob();
      const arq = new File([blob], escolhido.nome, { type: escolhido.mime || blob.type });
      setArquivoOriginal(arq);
      if (arq.type === "application/pdf") {
        const total = await contarPaginas(arq);
        setTotalPaginas(total);
        setPaginaEscolhida(total);
        if (total < 1) throw new Error("PDF sem páginas");
        setPreview(await renderizarPagina(arq, total));
      } else {
        setPreview(URL.createObjectURL(arq));
      }
      setPos({ fx: 0.68, fy: 0.78, fw: 0.24 });
      setAberto(true);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  // Arrastar (mover) e redimensionar a assinatura sobre a página
  function iniciar(e: React.PointerEvent, tipo: "mover" | "redim") {
    e.preventDefault();
    arrasto.current = { tipo, x: e.clientX, y: e.clientY, pos };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function mover(e: React.PointerEvent) {
    const a = arrasto.current;
    const cont = contRef.current;
    if (!a || !cont) return;
    const dx = (e.clientX - a.x) / cont.clientWidth;
    const dy = (e.clientY - a.y) / cont.clientHeight;
    if (a.tipo === "mover") {
      const fw = a.pos.fw;
      setPos({ ...a.pos, fx: Math.min(Math.max(a.pos.fx + dx, 0), 1 - fw), fy: Math.min(Math.max(a.pos.fy + dy, 0), 0.95) });
    } else {
      setPos({ ...a.pos, fw: Math.min(Math.max(a.pos.fw + dx, 0.05), 1 - a.pos.fx) });
    }
  }
  function soltar() {
    arrasto.current = null;
  }

  async function confirmar() {
    if (!arquivoOriginal || !escolhido) return;
    setOcupado(true);
    setErro("");
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const sigBytes = new Uint8Array(await (await fetch(assinaturaUrl)).arrayBuffer());
      let doc: PDFDocumento;
      let pagina;
      if (arquivoOriginal.type === "application/pdf") {
        doc = await PDFDoc.load(new Uint8Array(await arquivoOriginal.arrayBuffer()));
        pagina = doc.getPage(Math.min(paginaEscolhida, doc.getPageCount()) - 1);
      } else {
        // Imagem: vira uma página do PDF com o próprio tamanho da imagem.
        doc = await PDFDoc.create();
        const img = new Image();
        img.src = preview!;
        await img.decode();
        const bytes = new Uint8Array(await arquivoOriginal.arrayBuffer());
        const embutida = arquivoOriginal.type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        pagina = doc.addPage([embutida.width, embutida.height]);
        pagina.drawImage(embutida, { x: 0, y: 0, width: embutida.width, height: embutida.height });
      }
      const sig = assinaturaMime === "image/png" ? await doc.embedPng(sigBytes) : await doc.embedJpg(sigBytes);
      const { width: pw, height: ph } = pagina.getSize();
      const w = pos.fw * pw;
      const h = w * (sig.height / sig.width);
      pagina.drawImage(sig, { x: pos.fx * pw, y: ph - pos.fy * ph - h, width: w, height: h });
      const saida = new Uint8Array(await doc.save());

      const sb = criarClienteNavegador();
      const caminho = `${obraId}/${pagamentoId}/${crypto.randomUUID()}.pdf`;
      const up = await sb.storage.from("documentos").upload(caminho, saida, { contentType: "application/pdf" });
      if (up.error) throw new Error(up.error.message);
      const { error } = await sb.rpc("registrar_documento", {
        p_pagamento_id: pagamentoId,
        p_tipo: "documento_assinado",
        p_nome_arquivo: `${escolhido.nome.replace(/\.[^.]+$/, "")} - assinado.pdf`.slice(0, 200),
        p_storage_path: caminho,
        p_mime_type: "application/pdf",
        p_tamanho: saida.length,
        p_sha256: await sha256Hex(saida),
      });
      if (error) throw new Error(error.message);
      setAberto(false);
      setOk("Documento assinado. O original foi preservado e a versão assinada ficou anexada ao pagamento.");
      router.refresh();
    } catch (e) {
      setErro(`Não foi possível assinar: ${(e as Error).message}`);
    } finally {
      setOcupado(false);
    }
  }

  if (documentos.length === 0) return null;
  return (
    <Cartao titulo="Assinar documento">
      {ok && <div className="mb-3"><Aviso tipo="sucesso">{ok}</Aviso></div>}
      {erro && <div className="mb-3"><Aviso tipo="erro">{erro}</Aviso></div>}
      <div className="space-y-3">
        <Campo rotulo="Documento">
          <select className="campo" value={escolhido?.id ?? ""} onChange={(e) => setEscolhido(documentos.find((d) => d.id === e.target.value) ?? null)}>
            {documentos.map((d) => (
              <option key={d.id} value={d.id}>{d.nome}</option>
            ))}
          </select>
        </Campo>
        <Botao onClick={abrir} disabled={ocupado || !escolhido}>{ocupado ? "Abrindo…" : "Abrir e posicionar a assinatura"}</Botao>
        <p className="text-xs text-slate-500">O documento original não é alterado: a versão assinada é uma nova versão anexada ao pagamento.</p>
      </div>

      {aberto && preview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-3xl rounded-lg bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Posicione sua assinatura</h3>
              <button type="button" onClick={() => setAberto(false)} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">✕</button>
            </div>
            {totalPaginas > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="font-medium text-slate-700">Página da assinatura</span>
                  <select
                    className="campo w-auto"
                    value={paginaEscolhida}
                    disabled={ocupado}
                    onChange={async (e) => {
                      const n = Number(e.target.value);
                      if (!arquivoOriginal || arquivoOriginal.type !== "application/pdf") return;
                      setOcupado(true);
                      try {
                        setPreview(await renderizarPagina(arquivoOriginal, n));
                        setPaginaEscolhida(n);
                      } finally {
                        setOcupado(false);
                      }
                    }}
                  >
                    {Array.from({ length: totalPaginas }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n} de {totalPaginas}{n === totalPaginas ? " (última)" : ""}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <p className="mb-3 text-xs text-slate-600">Escolha a página, arraste a assinatura para o lugar desejado e use o canto inferior direito para ajustar o tamanho. Só uma assinatura é colocada, na página escolhida.</p>
            <div ref={contRef} className="relative mx-auto inline-block max-w-full select-none overflow-hidden rounded border border-slate-300 bg-slate-100" style={{ touchAction: "none" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Página escolhida para a assinatura" className="block max-h-[60vh] max-w-full" draggable={false} />
              <div
                onPointerDown={(e) => iniciar(e, "mover")}
                onPointerMove={mover}
                onPointerUp={soltar}
                onPointerCancel={soltar}
                className="absolute cursor-move border-2 border-dashed border-marca-500 bg-white/40"
                style={{ left: `${pos.fx * 100}%`, top: `${pos.fy * 100}%`, width: `${pos.fw * 100}%` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assinaturaUrl} alt="Assinatura" className="pointer-events-none block w-full" draggable={false} />
                <div
                  onPointerDown={(e) => { e.stopPropagation(); iniciar(e, "redim"); }}
                  onPointerMove={mover}
                  onPointerUp={soltar}
                  onPointerCancel={soltar}
                  className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm bg-marca-600"
                  aria-label="Ajustar tamanho"
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Botao onClick={confirmar} disabled={ocupado} variante="sucesso">{ocupado ? "Gerando documento assinado…" : "Confirmar assinatura"}</Botao>
              <Botao onClick={() => setAberto(false)} variante="secundario">Cancelar</Botao>
            </div>
          </div>
        </div>
      )}
    </Cartao>
  );
}
