"use client";

import { useEffect } from "react";

/** Abre o <details> indicado no endereço (#anexar, #cancelar…) e rola até ele. */
export function AbrirPorAncora() {
  useEffect(() => {
    const abrir = () => {
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.querySelector("details")?.setAttribute("open", "");
      el.scrollIntoView({ block: "center" });
    };
    abrir();
    window.addEventListener("hashchange", abrir);
    return () => window.removeEventListener("hashchange", abrir);
  }, []);
  return null;
}
