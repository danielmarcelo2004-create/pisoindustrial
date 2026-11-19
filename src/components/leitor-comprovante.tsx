"use client";

import { useEffect, useRef, useState } from "react";
import { lerComprovante, semelhancaNome } from "@/lib/comprovantes-banco";
import { data, moeda, valorParaCampo } from "@/lib/formato";

/** Muda o valor de um campo (também os controlados) e avisa o formulário. */
function definir(input: HTMLInputElement | null, valor: string) {
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, valor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * campoValor: nome do campo de valor pago, ou "parcela" para lançar a diferença como juros/desconto.
 * Lê o comprovante escolhido no formulário de baixa (campo "comprovante") e preenche a data e o
 * valor pago. Avisa quando o valor ou o favorecido não conferem com o pagamento. Não bloqueia.
 */
export function LeitorComprovante({ valor, favorecido, campoValor = "valor_pago" }: { valor: number; favorecido: string; campoValor?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState<{ tipo: "info" | "alerta"; texto: string[] } | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const aoMudar = async (e: Event) => {
      const alvo = e.target as HTMLInputElement;
      if (alvo.type !== "file" || alvo.name !== "comprovante") return;
      const arq = alvo.files?.[0];
      if (!arq) return setMsg(null);
      if (!/pdf$/i.test(arq.type) && !/\.pdf$/i.test(arq.name)) return setMsg({ tipo: "info", texto: ["Comprovante anexado. A leitura automática funciona com PDF."] });
      setMsg({ tipo: "info", texto: ["Lendo o comprovante…"] });
      try {
        const { criarOcr, lerTextoPaginas } = await import("@/lib/ocr/comprovantes");
        let ocr: Awaited<ReturnType<typeof criarOcr>> | null = null;
        const textos = await lerTextoPaginas(arq, async () => (ocr ??= await criarOcr()));
        if (ocr) await (ocr as { terminate: () => Promise<unknown> }).terminate();
        const c = lerComprovante(textos[0] ?? "");
        if (c.valor === null && !c.data) return setMsg({ tipo: "alerta", texto: ["Não consegui ler o comprovante. Confira a data e o valor manualmente."] });
        const linhas = [`Comprovante ${c.tipo === "pix" ? "PIX" : c.tipo === "boleto" ? "de boleto" : ""} lido: ${c.valor !== null ? moeda(c.valor) : "valor não lido"}${c.data ? ` em ${data(c.data)}` : ""}${c.beneficiario ? ` para ${c.beneficiario}` : ""}. Data e valor preenchidos.`];
        if (c.data) definir(form.querySelector<HTMLInputElement>('input[name="pago_em"]'), c.data);
        let alerta = false;
        if (c.valor !== null) {
          const diferente = Math.abs(c.valor - valor) >= 0.005;
          if (campoValor === "parcela") {
            // Parcela: a diferença vira juros (pagou mais) ou desconto (pagou menos), com o motivo
            const dif = Math.round((c.valor - valor) * 100) / 100;
            definir(form.querySelector<HTMLInputElement>('input[name="juros"]'), dif > 0 ? valorParaCampo(dif) : "");
            definir(form.querySelector<HTMLInputElement>('input[name="desconto"]'), dif < 0 ? valorParaCampo(-dif) : "");
            definir(form.querySelector<HTMLInputElement>('input[name="motivo"]'), dif !== 0 ? "Diferença conforme o comprovante" : "");
          } else {
            definir(form.querySelector<HTMLInputElement>(`input[name="${campoValor}"]`), diferente ? valorParaCampo(c.valor) : "");
          }
          if (diferente) {
            alerta = true;
            linhas.push(`O valor do comprovante (${moeda(c.valor)}) é diferente do valor do pagamento (${moeda(valor)}).`);
          }
        }
        if (textos.length > 1) linhas.push(`O PDF tem ${textos.length} páginas: foi lida só a primeira. Para vários comprovantes, marque os pagamentos na lista e use Baixar.`);
        if (c.beneficiario && semelhancaNome(c.beneficiario, favorecido) < 0.5 && !c.cnpj && !c.cpfMeio) {
          alerta = true;
          linhas.push(`O favorecido do comprovante (${c.beneficiario}) não parece ser ${favorecido}. Confira se é o comprovante certo.`);
        } else if (c.beneficiario && semelhancaNome(c.beneficiario, favorecido) < 0.5) {
          linhas.push(`Favorecido no comprovante: ${c.beneficiario}. Confira se é o comprovante deste pagamento.`);
        }
        setMsg({ tipo: alerta ? "alerta" : "info", texto: linhas });
      } catch {
        setMsg({ tipo: "alerta", texto: ["Não consegui ler o comprovante. Confira a data e o valor manualmente."] });
      }
    };
    form.addEventListener("change", aoMudar);
    return () => form.removeEventListener("change", aoMudar);
  }, [valor, favorecido, campoValor]);

  return (
    <div ref={ref} className={msg ? "" : "hidden"} role="status">
      {msg && (
        <div className={msg.tipo === "alerta" ? "rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" : "rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"}>
          {msg.texto.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}
    </div>
  );
}
