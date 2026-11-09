import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { Cor } from "@/lib/rotulos";

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}
export { cx };

const VARIANTES = {
  primario: "bg-marca-700 text-white hover:bg-marca-800 shadow-xs",
  secundario: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-xs",
  perigo: "bg-red-600 text-white hover:bg-red-700 shadow-xs",
  sucesso: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-xs",
  fantasma: "text-slate-600 hover:bg-slate-100",
} as const;
export type Variante = keyof typeof VARIANTES;

export function classeBotao(variante: Variante = "primario", tamanho: "sm" | "md" = "md") {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marca-500",
    tamanho === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm",
    VARIANTES[variante],
  );
}

export function Botao({
  variante = "primario",
  tamanho = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variante?: Variante; tamanho?: "sm" | "md" }) {
  return <button className={cx(classeBotao(variante, tamanho), className)} {...props} />;
}

export function LinkBotao({
  variante = "primario",
  tamanho = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variante?: Variante; tamanho?: "sm" | "md" }) {
  return <Link className={cx(classeBotao(variante, tamanho), className)} {...props} />;
}

export function Cartao({
  titulo,
  acoes,
  children,
  className,
  semPadding,
}: {
  titulo?: ReactNode;
  acoes?: ReactNode;
  children: ReactNode;
  className?: string;
  semPadding?: boolean;
}) {
  return (
    <section className={cx("min-w-0 rounded-lg border border-slate-200 bg-white shadow-xs", className)}>
      {(titulo || acoes) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          {titulo && <h2 className="text-sm font-semibold text-slate-800">{titulo}</h2>}
          {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
        </header>
      )}
      <div className={semPadding ? "" : "p-4"}>{children}</div>
    </section>
  );
}

const CORES: Record<Cor, string> = {
  amarelo: "bg-amber-50 text-amber-800 ring-amber-600/20",
  azul: "bg-sky-50 text-sky-800 ring-sky-600/20",
  verde: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  vermelho: "bg-red-50 text-red-800 ring-red-600/20",
  cinza: "bg-slate-100 text-slate-700 ring-slate-500/20",
  roxo: "bg-violet-50 text-violet-800 ring-violet-600/20",
};

export function Selo({ cor = "cinza", children }: { cor?: Cor; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", CORES[cor])}>
      {children}
    </span>
  );
}

export function Cabecalho({
  titulo,
  subtitulo,
  acoes,
  voltar,
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  acoes?: ReactNode;
  voltar?: { href: string; rotulo: string };
}) {
  return (
    <div className="mb-6">
      {voltar && (
        <Link href={voltar.href} className="mb-2 inline-block text-sm text-marca-600 hover:underline">
          ← {voltar.rotulo}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{titulo}</h1>
          {subtitulo && <div className="mt-1 text-sm text-slate-500">{subtitulo}</div>}
        </div>
        {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
      </div>
    </div>
  );
}

export function Campo({
  rotulo,
  ajuda,
  children,
  className,
  obrigatorio,
}: {
  rotulo: ReactNode;
  ajuda?: ReactNode;
  children: ReactNode;
  className?: string;
  obrigatorio?: boolean;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {rotulo}
        {obrigatorio && <span className="text-red-600"> *</span>}
      </span>
      {children}
      {ajuda && <span className="mt-1 block text-xs text-slate-500">{ajuda}</span>}
    </label>
  );
}

export function Aviso({ tipo = "info", children }: { tipo?: "info" | "erro" | "sucesso" | "alerta"; children: ReactNode }) {
  const c = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    erro: "border-red-200 bg-red-50 text-red-900",
    sucesso: "border-emerald-200 bg-emerald-50 text-emerald-900",
    alerta: "border-amber-200 bg-amber-50 text-amber-900",
  }[tipo];
  return (
    <div role={tipo === "erro" ? "alert" : "status"} className={cx("rounded-md border px-3 py-2 text-sm", c)}>
      {children}
    </div>
  );
}

export function Vazio({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}

export function Indicador({
  rotulo,
  valor,
  detalhe,
  cor = "marca",
  href,
}: {
  rotulo: string;
  valor: ReactNode;
  detalhe?: ReactNode;
  cor?: "marca" | "vermelho" | "amarelo" | "verde" | "azul";
  href?: string;
}) {
  const barra = {
    marca: "bg-marca-600",
    vermelho: "bg-red-500",
    amarelo: "bg-amber-500",
    verde: "bg-emerald-500",
    azul: "bg-sky-500",
  }[cor];
  const conteudo = (
    <div className="relative h-full overflow-hidden rounded-lg border border-slate-200 bg-white p-4 shadow-xs transition hover:border-slate-300">
      <span className={cx("absolute inset-y-0 left-0 w-1", barra)} />
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">{rotulo}</div>
      <div className={cx("mt-1 font-semibold whitespace-nowrap text-slate-900 tabular-nums", typeof valor === "string" ? "text-lg xl:text-base 2xl:text-lg" : "text-2xl")}>{valor}</div>
      {detalhe && <div className="mt-1 text-xs text-slate-500">{detalhe}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {conteudo}
    </Link>
  ) : (
    conteudo
  );
}

export function Dado({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{rotulo}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}
