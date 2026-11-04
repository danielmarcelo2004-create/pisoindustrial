"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cx } from "@/components/ui";

export type ItemMenu = { href: string; rotulo: string; icone: ReactNode; contador?: number; emBreve?: boolean };

function ativo(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

function Lista({ itens, aoClicar }: { itens: ItemMenu[]; aoClicar?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {itens.map((i) =>
        i.emBreve ? (
          <li key={i.href}>
            <span
              className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-marca-200/50"
              title="Previsto para as próximas etapas"
            >
              <span className="h-4 w-4 shrink-0">{i.icone}</span>
              <span className="flex-1">{i.rotulo}</span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase">em breve</span>
            </span>
          </li>
        ) : (
          <li key={i.href}>
            <Link
              href={i.href}
              onClick={aoClicar}
              className={cx(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                ativo(pathname, i.href) ? "bg-white/10 font-medium text-white" : "text-marca-100 hover:bg-white/5 hover:text-white",
              )}
            >
              <span className="h-4 w-4 shrink-0">{i.icone}</span>
              <span className="flex-1">{i.rotulo}</span>
              {!!i.contador && (
                <span className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-marca-900">{i.contador}</span>
              )}
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

export function Navegacao({
  principal,
  futuro,
  marca,
  rodape,
}: {
  principal: ItemMenu[];
  futuro: ItemMenu[];
  marca: ReactNode;
  rodape: ReactNode;
}) {
  const [aberto, setAberto] = useState(false);
  const conteudo = (fechar?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="px-4 py-4">{marca}</div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-2 pb-4" aria-label="Menu principal">
        <Lista itens={principal} aoClicar={fechar} />
        {futuro.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-marca-200/60 uppercase">Próximas etapas</div>
            <Lista itens={futuro} />
          </div>
        )}
      </nav>
      <div className="border-t border-white/10 p-3">{rodape}</div>
    </div>
  );

  return (
    <>
      {/* Desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 bg-marca-900 lg:block">{conteudo()}</aside>

      {/* Mobile */}
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="fixed top-3 left-3 z-40 rounded-md bg-marca-900 p-2 text-white shadow lg:hidden"
        aria-label="Abrir menu"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 5A.75.75 0 0 1 2.75 9h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 9.75Zm.75 4.25a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5H2.75Z" />
        </svg>
      </button>
      {aberto && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setAberto(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-marca-900 shadow-xl">{conteudo(() => setAberto(false))}</aside>
        </div>
      )}
    </>
  );
}
