"use client";

import { useEffect, useRef, useState } from "react";
import { verificarDuplicidade } from "@/app/(app)/pagamentos/actions";
import { avisoCpfCnpj } from "@/lib/documento-fiscal";
import { motivoNaoUtil, proximoDiaUtil } from "@/lib/dias-uteis";
import { data, hojeISO, lerValor, moeda } from "@/lib/formato";
import { STATUS_PAGAMENTO, type StatusPagamento } from "@/lib/rotulos";

type Duplicado = { pagamento_id: string; numero: number; obra: string; valor: number; vencimento: string; status: StatusPagamento; motivo: string };

const MESES_LIMITE = 12;

function mesesEntre(a: string, b: string) {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return Math.abs((ya - yb) * 12 + (ma - mb));
}

/** Muda o valor de um input (também os controlados pelo React) e avisa o formulário. */
function definirValor(input: HTMLInputElement, valor: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, valor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fornecedorEscolhido(f: HTMLFormElement) {
  const opcao = f.querySelector<HTMLSelectElement>('select[name="fornecedor_id"]')?.selectedOptions[0];
  return opcao?.value ? opcao.text : "";
}

async function sha256(arq: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await arq.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Avisos do lançamento (não bloqueiam o envio):
 * vencimento no passado, vencimento em fim de semana/feriado nacional (com sugestão do próximo dia útil),
 * competência muito distante de hoje, CPF/CNPJ inválido e possível duplicidade.
 */
export function AvisosLancamento({
  valor,
  excluirPagamentoId,
  camposArquivo = "boleto,nota_fiscal",
  duplicidade = true,
}: {
  /** Valor calculado fora do formulário (OP: total dos itens). Sem ele, lê o campo "valor". */
  valor?: number;
  /** Na edição: não avisar que o próprio pagamento é duplicado. */
  excluirPagamentoId?: string;
  /** Nomes (separados por vírgula) dos campos de arquivo usados no aviso de duplicidade. */
  camposArquivo?: string;
  duplicidade?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [campos, setCampos] = useState({ vencimento: "", competencia: "", favorecido: "", valorCampo: "", cpf: "" });
  const [hashes, setHashes] = useState<string[]>([]);
  const [duplicados, setDuplicados] = useState<Duplicado[]>([]);

  useEffect(() => {
    const f = ref.current?.closest("form");
    if (!f) return;
    const val = (nome: string) => (f.querySelector<HTMLInputElement>(`[name="${nome}"]`)?.value ?? "").trim();
    const ler = () =>
      setCampos({
        vencimento: val("vencimento"),
        competencia: val("data_competencia"),
        favorecido: val("favorecido") || fornecedorEscolhido(f),
        valorCampo: val("valor"),
        cpf: val("cpf_cnpj"),
      });
    const aoMudar = async (e: Event) => {
      ler();
      const alvo = e.target as HTMLInputElement;
      const nomes = camposArquivo.split(",");
      if (alvo.type === "file" && nomes.includes(alvo.name)) {
        const todos = nomes.flatMap((n) => Array.from(f.querySelectorAll<HTMLInputElement>(`input[type=file][name="${n}"]`)).flatMap((i) => Array.from(i.files ?? [])));
        try {
          setHashes(await Promise.all(todos.map(sha256)));
        } catch {
          setHashes([]);
        }
      }
    };
    ler();
    f.addEventListener("input", aoMudar);
    f.addEventListener("change", aoMudar);
    return () => {
      f.removeEventListener("input", aoMudar);
      f.removeEventListener("change", aoMudar);
    };
  }, [camposArquivo]);

  const valorNum = valor ?? lerValor(campos.valorCampo);

  // Duplicidade: consulta com uma pequena espera depois da última alteração.
  useEffect(() => {
    if (!duplicidade) return;
    const temChave = hashes.length > 0 || (campos.favorecido && valorNum && /^\d{4}-\d{2}-\d{2}$/.test(campos.vencimento));
    if (!temChave) return;
    let ativo = true;
    const t = setTimeout(async () => {
      try {
        const r = await verificarDuplicidade({ hashes, favorecido: campos.favorecido, valor: valorNum || null, vencimento: campos.vencimento });
        if (ativo) setDuplicados((r as Duplicado[]).filter((d) => d.pagamento_id !== excluirPagamentoId));
      } catch {
        /* aviso é opcional */
      }
    }, 600);
    return () => {
      ativo = false;
      clearTimeout(t);
    };
  }, [duplicidade, hashes, campos.favorecido, campos.vencimento, valorNum, excluirPagamentoId]);

  const hoje = hojeISO();
  const avisos: React.ReactNode[] = [];
  const venc = campos.vencimento;
  if (/^\d{4}-\d{2}-\d{2}$/.test(venc)) {
    if (venc < hoje) avisos.push(<span key="passado">O vencimento ({data(venc)}) já passou. Confira a data: o lançamento será salvo assim mesmo.</span>);
    const motivo = motivoNaoUtil(venc);
    if (motivo) {
      const sugestao = proximoDiaUtil(venc);
      avisos.push(
        <span key="util">
          O vencimento cai em {motivo}. Normalmente o pagamento fica para o próximo dia útil ({data(sugestao)}).{" "}
          <button
            type="button"
            className="font-medium text-marca-700 underline"
            onClick={() => {
              const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>('input[name="vencimento"]');
              if (input) definirValor(input, sugestao);
            }}
          >
            Usar {data(sugestao).slice(0, 5)}
          </button>
        </span>,
      );
    }
  }
  const comp = campos.competencia;
  if (/^\d{4}-\d{2}-\d{2}$/.test(comp) && mesesEntre(comp, hoje) > MESES_LIMITE) {
    avisos.push(<span key="comp">A competência ({data(comp)}) está a mais de {MESES_LIMITE} meses de hoje. Confira se a data está certa.</span>);
  }
  const cpf = avisoCpfCnpj(campos.cpf);
  if (cpf) avisos.push(<span key="cpf">{cpf}</span>);

  return (
    <div ref={ref} className={avisos.length || duplicados.length ? "space-y-2 sm:col-span-full" : "hidden"} data-avisos-lancamento>
      {avisos.length > 0 && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <ul className="list-disc space-y-1 pl-4">
            {avisos.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {duplicados.length > 0 && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">Possível lançamento duplicado — confira antes de enviar:</p>
          <ul className="mt-1 space-y-0.5">
            {duplicados.map((d) => (
              <li key={d.pagamento_id}>
                <a href={`/pagamentos/${d.pagamento_id}`} target="_blank" rel="noopener" className="text-marca-700 underline">
                  Pagamento nº {d.numero}
                </a>{" "}
                · {d.obra} · {moeda(d.valor)} · venc. {data(d.vencimento)} · {STATUS_PAGAMENTO[d.status]?.rotulo ?? d.status} — {d.motivo}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            Se for a mesma nota dividida entre centros de custo (ou uma cobrança realmente nova), pode seguir: o aviso não impede o
            cadastro.
          </p>
        </div>
      )}
    </div>
  );
}
