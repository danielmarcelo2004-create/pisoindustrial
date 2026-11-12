"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Estado } from "@/lib/erros";
import { Aviso, Botao, type Variante } from "@/components/ui";

type Acao = (estado: Estado, fd: FormData) => Promise<Estado>;

const PendenteCtx = createContext(false);

export function BotaoEnviar({
  children,
  variante = "primario",
  tamanho = "md",
  pendente = "Salvando…",
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  variante?: Variante;
  tamanho?: "sm" | "md";
  pendente?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const enviando = useContext(PendenteCtx);
  return (
    <Botao type="submit" variante={variante} tamanho={tamanho} disabled={enviando || disabled} name={name} value={value}>
      {enviando ? pendente : children}
    </Botao>
  );
}

/**
 * Formulário ligado a uma Server Action. Mostra erro/sucesso retornados,
 * bloqueia o botão durante o envio e NÃO apaga o que foi digitado quando há erro.
 */
export function FormAcao({
  action,
  children,
  enviar = "Salvar",
  pendente,
  variante = "primario",
  className,
  rodape,
  confirmar,
  semBotao,
  limparAoConcluir,
  limparErroAoMudar,
}: {
  action: Acao;
  children?: ReactNode;
  enviar?: ReactNode;
  pendente?: string;
  variante?: Variante;
  className?: string;
  rodape?: ReactNode;
  confirmar?: string;
  semBotao?: boolean;
  limparAoConcluir?: boolean;
  /** Esconde o erro quando um destes campos muda e o erro contém o trecho (ex.: anexar o documento que faltava). */
  limparErroAoMudar?: { campos: string[]; trecho: string };
}) {
  const [estado, formAction, enviando] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  // Guarda a resposta em que o erro foi escondido: uma resposta nova volta a mostrar o erro.
  const [ocultoEm, setOcultoEm] = useState<Estado | null>(null);
  const erroOculto = ocultoEm !== null && ocultoEm === estado;
  useEffect(() => {
    if (limparAoConcluir && estado?.ok) formRef.current?.reset();
  }, [estado, limparAoConcluir]);
  return (
    <PendenteCtx value={enviando}>
      <form
        ref={formRef}
        className={className ?? "space-y-4"}
        onChange={(e) => {
          const nome = (e.target as unknown as HTMLInputElement).name;
          if (limparErroAoMudar && estado?.erro?.includes(limparErroAoMudar.trecho) && limparErroAoMudar.campos.includes(nome)) {
            setOcultoEm(estado);
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmar && !window.confirm(confirmar)) return;
          const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
          const fd = new FormData(e.currentTarget, submitter);
          startTransition(() => formAction(fd));
        }}
      >
        {children}
        {estado?.erro && !erroOculto && <Aviso tipo="erro">{estado.erro}</Aviso>}
        {estado?.ok && <Aviso tipo="sucesso">{estado.ok}</Aviso>}
        {!semBotao && (
          <div className="flex flex-wrap items-center gap-2">
            <BotaoEnviar variante={variante} pendente={pendente}>
              {enviar}
            </BotaoEnviar>
            {rodape}
          </div>
        )}
      </form>
    </PendenteCtx>
  );
}
