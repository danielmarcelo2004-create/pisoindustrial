"use client";

import { useRef, useState } from "react";
import type { PDFDocument as PDFDocumento } from "pdf-lib";
import { useRouter } from "next/navigation";
import { Aviso, Botao } from "@/components/ui";
import { sha256Hex } from "@/lib/fundos";
import { renderizarPagina, contarPaginas } from "@/lib/ocr/comprovantes";
import { criarClienteNavegador } from "@/lib/supabase/navegador";

export type AnexoGasto = { id: string; storage_path: string; nome_arquivo: string; mime_type: string | null; assinado: boolean };
type Pos = { fx: number; fy: number; fw: number };
type Alvo = { arquivo: File; nome: string; preview: string };

const POS_INICIAL: Pos = { fx: 0.68, fy: 0.78, fw: 0.24 };
const EXTENSOES: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/** Texto do erro, qualquer que seja o valor lançado (Error, objeto do Supabase ou texto). */
function mensagemDe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return "erro desconhecido";
  }
}

/** Tipo do arquivo pelo nome, para quando o banco não guardou o tipo. */
function tipoPeloNome(nome: string): string | null {
  const ext = nome.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return null;
}

export function AnexosGasto({
  gastoId,
  fundoId,
  anexos,
  podeEnviar,
  podeRemover,
  assinaturaUrl,
  assinaturaMime,
}: {
  gastoId: string;
  fundoId: string;
  anexos: AnexoGasto[];
  podeEnviar: boolean;
  podeRemover: boolean;
  assinaturaUrl: string | null;
  assinaturaMime: "image/png" | "image/jpeg";
}) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");
  const [alvo, setAlvo] = useState<Alvo | null>(null);
  const [pos, setPos] = useState<Pos>(POS_INICIAL);
  const contRef = useRef<HTMLDivElement>(null);
  const arrasto = useRef<{ tipo: "mover" | "redim"; x: number; y: number; pos: Pos } | null>(null);

  async function ver(a: AnexoGasto) {
    setErro("");
    const janela = window.open("", "_blank");
    const { data, error } = await criarClienteNavegador().storage.from("documentos").createSignedUrl(a.storage_path, 300);
    if (error || !data) {
      janela?.close();
      setErro("Não foi possível abrir o anexo.");
      return;
    }
    if (janela) janela.location.href = data.signedUrl;
    else window.open(data.signedUrl, "_blank");
  }

  async function remover(a: AnexoGasto) {
    if (!window.confirm(`Remover "${a.nome_arquivo}" deste gasto? O arquivo continua guardado, mas deixa de estar anexado.`)) return;
    setErro("");
    setOk("");
    setOcupado(true);
    try {
      const { error } = await criarClienteNavegador().rpc("remover_anexo_gasto", { p_anexo_id: a.id });
      if (error) throw new Error(error.message);
      setOk("Anexo removido do gasto.");
      router.refresh();
    } catch (e) {
      setErro(`Não foi possível remover: ${mensagemDe(e)}`);
    } finally {
      setOcupado(false);
    }
  }

  async function montarAlvo(arquivo: File, nome: string) {
    let preview: string;
    if (arquivo.type === "application/pdf") {
      const total = await contarPaginas(arquivo);
      if (total < 1) throw new Error("PDF sem páginas");
      preview = await renderizarPagina(arquivo, total);
    } else {
      preview = URL.createObjectURL(arquivo);
    }
    setPos(POS_INICIAL);
    setAlvo({ arquivo, nome, preview });
  }

  async function enviarOriginal(arquivo: File) {
    setErro("");
    setOk("");
    if (!EXTENSOES[arquivo.type]) {
      setErro("Envie um PDF, PNG ou JPG.");
      return;
    }
    if (arquivo.size > 10 * 1024 * 1024) {
      setErro("O arquivo passa de 10 MB.");
      return;
    }
    setOcupado(true);
    try {
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const caminho = `fundos/${fundoId}/${crypto.randomUUID()}.${EXTENSOES[arquivo.type]}`;
      const sb = criarClienteNavegador();
      const up = await sb.storage.from("documentos").upload(caminho, bytes, { contentType: arquivo.type });
      if (up.error) throw new Error(up.error.message);
      const { error } = await sb.rpc("registrar_anexo_gasto", {
        p_gasto_id: gastoId,
        p_storage_path: caminho,
        p_nome: arquivo.name.slice(0, 200),
        p_mime: arquivo.type,
        p_sha256: await sha256Hex(bytes),
        p_assinado: false,
      });
      if (error) throw new Error(error.message);
      router.refresh();
      if (assinaturaUrl) {
        await montarAlvo(arquivo, arquivo.name);
      } else {
        setOk("Comprovante anexado. Cadastre sua assinatura em Perfil para assiná-lo.");
      }
    } catch (e) {
      setErro(`Não foi possível anexar: ${mensagemDe(e)}`);
    } finally {
      setOcupado(false);
    }
  }

  async function assinarExistente(a: AnexoGasto) {
    setErro("");
    setOk("");
    setOcupado(true);
    try {
      const { data, error } = await criarClienteNavegador().storage.from("documentos").createSignedUrl(a.storage_path, 300);
      if (error || !data) throw new Error("não foi possível abrir o anexo");
      const resposta = await fetch(data.signedUrl);
      if (!resposta.ok) throw new Error(`o arquivo não pôde ser baixado (${resposta.status})`);
      const blob = await resposta.blob();
      const tipo = a.mime_type ?? tipoPeloNome(a.nome_arquivo) ?? blob.type;
      await montarAlvo(new File([blob], a.nome_arquivo, { type: tipo }), a.nome_arquivo);
    } catch (e) {
      setErro(`Não foi possível assinar: ${mensagemDe(e)}`);
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
      setPos({ ...a.pos, fx: Math.min(Math.max(a.pos.fx + dx, 0), 1 - a.pos.fw), fy: Math.min(Math.max(a.pos.fy + dy, 0), 0.95) });
    } else {
      setPos({ ...a.pos, fw: Math.min(Math.max(a.pos.fw + dx, 0.05), 1 - a.pos.fx) });
    }
  }
  function soltar() {
    arrasto.current = null;
  }

  async function confirmarAssinatura() {
    if (!alvo || !assinaturaUrl) return;
    setOcupado(true);
    setErro("");
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const sigBytes = new Uint8Array(await (await fetch(assinaturaUrl)).arrayBuffer());
      let doc: PDFDocumento;
      let pagina;
      if (alvo.arquivo.type === "application/pdf") {
        doc = await PDFDoc.load(new Uint8Array(await alvo.arquivo.arrayBuffer()));
        pagina = doc.getPage(doc.getPageCount() - 1);
      } else {
        doc = await PDFDoc.create();
        const bytes = new Uint8Array(await alvo.arquivo.arrayBuffer());
        const embutida = alvo.arquivo.type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
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
      const caminho = `fundos/${fundoId}/${crypto.randomUUID()}.pdf`;
      const up = await sb.storage.from("documentos").upload(caminho, saida, { contentType: "application/pdf" });
      if (up.error) throw new Error(up.error.message);
      const { error } = await sb.rpc("registrar_anexo_gasto", {
        p_gasto_id: gastoId,
        p_storage_path: caminho,
        p_nome: `${alvo.nome.replace(/\.[^.]+$/, "")} - assinado.pdf`.slice(0, 200),
        p_mime: "application/pdf",
        p_sha256: await sha256Hex(saida),
        p_assinado: true,
      });
      if (error) throw new Error(error.message);
      setAlvo(null);
      setOk("Comprovante assinado. O original foi preservado e a versão assinada ficou anexada ao gasto.");
      router.refresh();
    } catch (e) {
      setErro(`Não foi possível assinar: ${mensagemDe(e)}`);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-2">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {ok && <Aviso tipo="sucesso">{ok}</Aviso>}
      {anexos.length > 0 && (
        <ul className="space-y-1 text-sm">
          {anexos.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => ver(a)} className="text-marca-700 hover:underline">
                {a.nome_arquivo}
              </button>
              <span className={a.assinado ? "text-xs text-emerald-700" : "text-xs text-amber-700"}>
                {a.assinado ? "assinado" : "sem assinatura"}
              </span>
              {podeEnviar && !a.assinado && assinaturaUrl && (
                <button type="button" onClick={() => assinarExistente(a)} disabled={ocupado} className="text-xs text-marca-700 hover:underline disabled:opacity-60">
                  Assinar
                </button>
              )}
              {podeRemover && (
                <button type="button" onClick={() => remover(a)} disabled={ocupado} className="text-xs text-red-700 hover:underline disabled:opacity-60">
                  Remover
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {podeEnviar && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <span className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
            {ocupado ? "Enviando…" : "Anexar comprovante"}
          </span>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="sr-only"
            disabled={ocupado}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) enviarOriginal(f);
            }}
          />
        </label>
      )}
      {podeEnviar && !assinaturaUrl && <p className="text-xs text-amber-700">Cadastre sua assinatura em Perfil para assinar os comprovantes.</p>}

      {alvo && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-3xl rounded-lg bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Posicione sua assinatura</h3>
              <button type="button" onClick={() => setAlvo(null)} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">✕</button>
            </div>
            <p className="mb-3 text-xs text-slate-600">Arraste a assinatura para o lugar desejado e use o canto inferior direito para ajustar o tamanho. A assinatura vai na última página. O comprovante original não é alterado.</p>
            <div ref={contRef} className="relative mx-auto select-none overflow-hidden rounded border border-slate-300 bg-slate-100" style={{ touchAction: "none" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={alvo.preview} alt="Última página do comprovante" className="block w-full" draggable={false} />
              <div
                onPointerDown={(e) => iniciar(e, "mover")}
                onPointerMove={mover}
                onPointerUp={soltar}
                onPointerCancel={soltar}
                className="absolute cursor-move border-2 border-dashed border-marca-500 bg-white/40"
                style={{ left: `${pos.fx * 100}%`, top: `${pos.fy * 100}%`, width: `${pos.fw * 100}%` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assinaturaUrl ?? ""} alt="Assinatura" className="pointer-events-none block w-full" draggable={false} />
                <div
                  onPointerDown={(e) => { e.stopPropagation(); iniciar(e, "redim"); }}
                  onPointerMove={mover}
                  onPointerUp={soltar}
                  onPointerCancel={soltar}
                  className="absolute -right-2 -bottom-2 h-4 w-4 cursor-nwse-resize rounded-sm bg-marca-600"
                  aria-label="Ajustar tamanho"
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Botao onClick={confirmarAssinatura} disabled={ocupado} variante="sucesso">{ocupado ? "Gerando comprovante assinado…" : "Confirmar assinatura"}</Botao>
              <Botao onClick={() => setAlvo(null)} variante="secundario">Cancelar</Botao>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
