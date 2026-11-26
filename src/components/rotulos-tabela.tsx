"use client";

import { useEffect } from "react";

/** No celular as tabelas viram cartões (CSS em globals.css). Aqui cada célula recebe o título da sua coluna (data-rotulo). */
export function RotulosTabela() {
  useEffect(() => {
    const marcar = () => {
      document.querySelectorAll<HTMLTableElement>("main table").forEach((t) => {
        const cab = t.tHead?.rows[0];
        if (!cab) return;
        const titulos: string[] = [];
        for (const th of Array.from(cab.cells)) {
          for (let i = 0; i < (th.colSpan || 1); i++) titulos.push((th.textContent ?? "").trim());
        }
        for (const tr of Array.from(t.tBodies).flatMap((b) => Array.from(b.rows))) {
          let col = 0;
          for (const td of Array.from(tr.cells)) {
            if (!td.hasAttribute("data-rotulo") && titulos[col] && td.dataset.rotuloAuto !== "0") td.setAttribute("data-rotulo-auto", titulos[col]);
            col += td.colSpan || 1;
          }
        }
      });
    };
    marcar();
    const obs = new MutationObserver(() => marcar());
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return null;
}
