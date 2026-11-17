"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Aviso, Botao } from "@/components/ui";
import { renderizarPagina, contarPaginas } from "@/lib/ocr/comprovantes";
import { assinarOPCriador } from "./actions";

type Pos = { fx: number; fy: number; fw: number };
const POS_INICIAL: Pos = { fx: 0.68, fy: 0.78, fw: 0.24 };

function mensagemDe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "erro desconhecido";
}

/**
 * O engenheiro que criou a OP assina a própria solicitação, antes de enviar.
 * A posição escolhida aqui é aplicada no PDF oficial no momento do envio.
 * Se a OP mudar depois da assinatura, ela precisa ser assinada de novo.
 */
export function AssinarOP({
  ordemId,
  assinaturaUrl,
  posSalva,
  assinada,
  desatualizada,
  onAssinada,
}: {
  ordemId: string;
  assinaturaUrl: string | null;
  posSalva: Pos | null;
  assinada: boolean;
  desatualizada: boolean;
  onAssinada?: (pos: Pos) => void;
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [previa, setPrevia] = useState<string | null>(null);
  const [pos, setPos] = useState<Pos>(posSalva ?? POS_INICIAL);
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const contRef = useRef<HTMLDivElement>(null);
  const arrasto = useRef<{ tipo: "mover" | "redim"; x: number; y: number; pos: Pos } | null>(null);

  async function abrir() {
    setErro("");
    setOk("");
    setCarregando(true);
    setAberto(true);
    setPos(posSalva ?? POS_INICIAL);
    try {
      const resp = await fetch(`/ops/${ordemId}/pdf`, { cache: "no-store" });
      if (!resp.ok) throw new Error("não foi possível gerar a prévia da OP");
      const arquivo = new File([await resp.blob()], "op.pdf", { type: "application/pdf" });
      const total = await contarPaginas(arquivo);
      setPrevia(await renderizarPagina(arquivo, total));
    } catch (e) {
      setErro(`Não foi possível abrir a prévia: ${mensagemDe(e)}`);
    } finally {
      setCarregando(false);
    }
  }

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

  async function confirmar() {
    setOcupado(true);
    setErro("");
    try {
      const r = await assinarOPCriador(ordemId, pos);
      if (r.erro) throw new Error(r.erro);
      setAberto(false);
      setOk("Assinatura registrada. Ela será aplicada ao PDF da OP quando você enviar a solicitação.");
      onAssinada?.(pos);
      router.refresh();
    } catch (e) {
      setErro(`Não foi possível assinar: ${mensagemDe(e)}`);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3">
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {ok && <Aviso tipo="sucesso">{ok}</Aviso>}
      {!assinaturaUrl && <Aviso tipo="alerta">Cadastre sua assinatura em Minha assinatura para assinar a OP.</Aviso>}
      {assinada && !desatualizada && (
        <p className="text-sm text-emerald-700">OP assinada por você. Se alterar a OP depois, será preciso assinar novamente.</p>
      )}
      {desatualizada && (
        <Aviso tipo="alerta">A OP foi alterada depois da sua assinatura. Assine novamente antes de enviar.</Aviso>
      )}
      <Botao type="button" onClick={abrir} disabled={!assinaturaUrl || carregando} variante={assinada && !desatualizada ? "secundario" : "primario"}>
        {carregando ? "Gerando prévia…" : assinada && !desatualizada ? "Alterar posição da assinatura" : "Assinar OP"}
      </Botao>

      {aberto && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-3xl rounded-lg bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Posicione sua assinatura na OP</h3>
              <button type="button" onClick={() => setAberto(false)} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">✕</button>
            </div>
            <p className="mb-3 text-xs text-slate-600">Arraste a assinatura para o lugar desejado e use o canto inferior direito para ajustar o tamanho. A assinatura vai na última página da OP.</p>
            {!previa || !assinaturaUrl ? (
              <p className="py-10 text-center text-sm text-slate-500">{erro || "Carregando prévia…"}</p>
            ) : (
              <div ref={contRef} className="relative mx-auto select-none overflow-hidden rounded border border-slate-300 bg-slate-100" style={{ touchAction: "none" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previa} alt="Última página da OP" className="block w-full" draggable={false} />
                <div
                  onPointerDown={(e) => iniciar(e, "mover")}
                  onPointerMove={mover}
                  onPointerUp={soltar}
                  onPointerCancel={soltar}
                  className="absolute cursor-move border-2 border-dashed border-marca-500 bg-white/40"
                  style={{ left: `${pos.fx * 100}%`, top: `${pos.fy * 100}%`, width: `${pos.fw * 100}%` }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assinaturaUrl} alt="Sua assinatura" className="pointer-events-none block w-full" draggable={false} />
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
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Botao onClick={confirmar} disabled={ocupado || !previa} variante="sucesso">{ocupado ? "Salvando…" : "Confirmar assinatura"}</Botao>
              <Botao onClick={() => setAberto(false)} variante="secundario">Cancelar</Botao>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
