"use client";

import { useEffect, useRef, useState } from "react";

const tamanho = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Campo de arquivos que acumula as escolhas: cada nova seleção soma à lista (não substitui),
 * cada arquivo pode ser removido e o envio do formulário leva todos (mesmo nome de campo).
 */
export function CampoArquivos({ nome, accept, rotuloBotao = "Escolher arquivos" }: { nome: string; accept?: string; rotuloBotao?: string }) {
  const [arquivos, setArquivos] = useState<File[]>([]);
  const real = useRef<HTMLInputElement>(null);
  const seletor = useRef<HTMLInputElement>(null);

  // O formulário limpo (ex.: depois de anexar) também limpa a lista.
  useEffect(() => {
    const form = real.current?.form;
    if (!form) return;
    const limpar = () => setArquivos([]);
    form.addEventListener("reset", limpar);
    return () => form.removeEventListener("reset", limpar);
  }, []);

  function aplicar(lista: File[]) {
    const input = real.current;
    if (!input) return;
    const dt = new DataTransfer();
    lista.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    // Avisa quem acompanha o campo (leitura do boleto, aviso de documento faltando).
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return (
    <div className="space-y-2">
      <input
        ref={real}
        type="file"
        name={nome}
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => setArquivos(Array.from(e.currentTarget.files ?? []))}
      />
      <input
        ref={seletor}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        aria-label={rotuloBotao}
        onChange={(e) => {
          const novos = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (!novos.length) return;
          // Não repete o mesmo arquivo (nome + tamanho)
          const lista = [...arquivos, ...novos.filter((n) => !arquivos.some((a) => a.name === n.name && a.size === n.size))];
          aplicar(lista);
        }}
      />
      <button
        type="button"
        onClick={() => seletor.current?.click()}
        className="flex w-full items-center gap-3 rounded-md border border-slate-300 bg-white p-1.5 text-left text-sm hover:bg-slate-50"
      >
        <span className="rounded bg-slate-100 px-3 py-1.5 font-medium text-slate-700">{arquivos.length ? "Adicionar mais" : rotuloBotao}</span>
        <span className="text-slate-500">{arquivos.length ? `${arquivos.length} arquivo(s)` : "Nenhum arquivo escolhido"}</span>
      </button>
      {arquivos.length > 0 && (
        <ul className="space-y-1 text-xs">
          {arquivos.map((a, i) => (
            <li key={`${a.name}-${a.size}-${i}`} className="flex items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1">
              <span className="truncate" title={a.name}>
                {a.name} <span className="text-slate-400">· {tamanho(a.size)}</span>
              </span>
              <button type="button" onClick={() => aplicar(arquivos.filter((_, j) => j !== i))} className="shrink-0 text-red-700 hover:underline" aria-label={`Remover ${a.name}`}>
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
