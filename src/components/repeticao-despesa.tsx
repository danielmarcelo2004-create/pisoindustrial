"use client";

import { useEffect, useState } from "react";

const PRESETS = [
  { valor: "1x2", intervalo: 1, vezes: 2, rotulo: "Mensal, 2 vezes (este + 1 provisão)" },
  { valor: "1x12", intervalo: 1, vezes: 12, rotulo: "Mensal, 12 vezes (este + 11 provisões)" },
];

function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}
const br = (iso: string) => iso.split("-").reverse().join("/");

/**
 * "Repetir lançamento?": o primeiro lançamento é este pagamento; os seguintes viram provisões
 * (com os próximos vencimentos), para virar pagamento quando o documento chegar.
 */
export function RepeticaoDespesa({ intervaloInicial = null, vezesInicial = null }: { intervaloInicial?: number | null; vezesInicial?: number | null }) {
  const presetInicial = PRESETS.find((p) => p.intervalo === intervaloInicial && p.vezes === vezesInicial)?.valor ?? (intervaloInicial ? "personalizar" : "1x2");
  const [ativo, setAtivo] = useState(Boolean(intervaloInicial && vezesInicial));
  const [opcao, setOpcao] = useState(presetInicial);
  const [intervalo, setIntervalo] = useState(String(intervaloInicial ?? 1));
  const [vezes, setVezes] = useState(String(vezesInicial ?? 2));
  const [vencimento, setVencimento] = useState("");
  const [ref, setRef] = useState<HTMLDivElement | null>(null);

  // Acompanha o vencimento do formulário para mostrar as datas das provisões
  useEffect(() => {
    const f = ref?.closest("form");
    if (!f) return;
    const ler = () => setVencimento(f.querySelector<HTMLInputElement>("input[name=vencimento]")?.value ?? "");
    ler();
    f.addEventListener("input", ler);
    f.addEventListener("change", ler);
    return () => {
      f.removeEventListener("input", ler);
      f.removeEventListener("change", ler);
    };
  }, [ref]);

  const preset = PRESETS.find((p) => p.valor === opcao);
  const n = preset ? preset.intervalo : Math.min(Math.max(Math.floor(Number(intervalo) || 1), 1), 12);
  const v = preset ? preset.vezes : Math.min(Math.max(Math.floor(Number(vezes) || 2), 2), 60);
  const datas = vencimento ? Array.from({ length: v - 1 }, (_, k) => somarMeses(vencimento, (k + 1) * n)) : [];

  return (
    <div ref={setRef} className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} aria-label="Repetir lançamento" />
        Repetir lançamento?
      </label>
      <input type="hidden" name="repetir_intervalo" value={ativo ? String(n) : ""} />
      <input type="hidden" name="repetir_vezes" value={ativo ? String(v) : ""} />
      {ativo && (
        <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <label className="block text-sm text-slate-700">
            Configurações de repetição <span className="text-red-600">*</span>
            <select value={opcao} onChange={(e) => setOpcao(e.target.value)} className="campo mt-1 sm:max-w-md" aria-label="Configurações de repetição">
              {PRESETS.map((p) => (
                <option key={p.valor} value={p.valor}>
                  {p.rotulo}
                </option>
              ))}
              <option value="personalizar">Personalizar…</option>
            </select>
          </label>
          {opcao === "personalizar" && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
              A cada
              <input type="number" min={1} max={12} value={intervalo} onChange={(e) => setIntervalo(e.target.value)} className="campo tabular-nums" style={{ width: "5rem" }} aria-label="A cada quantos meses" />
              mês(es),
              <input type="number" min={2} max={60} value={vezes} onChange={(e) => setVezes(e.target.value)} className="campo tabular-nums" style={{ width: "5rem" }} aria-label="Quantas vezes" />
              vez(es) no total
            </div>
          )}
          <p className="text-xs text-slate-600">
            Este lançamento é o 1º de {v}.{" "}
            {v - 1 === 1 ? (
              <>O outro será criado como <strong>provisão</strong> (aparece na Agenda e em Provisões)</>
            ) : (
              <>Os outros {v - 1} serão criados como <strong>provisões</strong> (aparecem na Agenda e em Provisões)</>
            )}{" "}
            para virar pagamento quando o boleto ou documento chegar.
            {datas.length > 0 && <> {datas.length === 1 ? "Vencimento" : "Vencimentos"}: {datas.map(br).join(", ")}.</>}
          </p>
        </div>
      )}
    </div>
  );
}
