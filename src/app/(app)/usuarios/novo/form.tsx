"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";
import { CaixaCredenciais } from "@/components/credenciais";
import { Aviso, Botao, Campo, Cartao } from "@/components/ui";
import { PERFIS } from "@/lib/rotulos";
import { criarUsuario } from "../actions";

export function FormNovoUsuario({ obras, senhaSugerida }: { obras: { id: string; nome: string }[]; senhaSugerida: string }) {
  const [estado, acao, pendente] = useActionState(criarUsuario, null);

  if (estado?.dados?.senha) {
    return (
      <Cartao>
        <Aviso tipo="sucesso">{estado.ok}</Aviso>
        <div className="mt-4">
          <CaixaCredenciais email={estado.dados.email} senha={estado.dados.senha} />
        </div>
        <div className="mt-4 flex gap-2">
          <Link href={`/usuarios/${estado.dados.id}`} className="text-sm text-marca-700 hover:underline">
            Abrir cadastro do usuário
          </Link>
          <span className="text-slate-300">·</span>
          {/* Recarrega a página para gerar nova senha sugerida e limpar o formulário. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/usuarios/novo" className="text-sm text-marca-700 hover:underline">
            Criar outro usuário
          </a>
        </div>
      </Cartao>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => acao(fd));
      }}
    >
      <Cartao titulo="Dados de acesso">
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo rotulo="Nome completo" obrigatorio>
            <input name="nome" required className="campo" />
          </Campo>
          <Campo rotulo="E-mail (login)" obrigatorio>
            <input name="email" type="email" required className="campo" autoComplete="off" />
          </Campo>
          <Campo rotulo="Telefone / WhatsApp" ajuda="Para alertas. O WhatsApp nunca é usado para assinar ou aprovar.">
            <input name="telefone" className="campo" placeholder="(71) 99999-9999" />
          </Campo>
          <Campo rotulo="Perfil" obrigatorio>
            <select name="perfil" required className="campo" defaultValue="">
              <option value="">Selecione…</option>
              {Object.entries(PERFIS).map(([v, r]) => (
                <option key={v} value={v}>
                  {r}
                </option>
              ))}
            </select>
          </Campo>
          <Campo rotulo="Senha provisória" ajuda="Gerada automaticamente. O usuário troca no primeiro acesso.">
            <input name="senha" defaultValue={senhaSugerida} className="campo font-mono" autoComplete="off" />
          </Campo>
        </div>
      </Cartao>
      <Cartao titulo="Acesso às obras">
        <p className="mb-3 text-xs text-slate-500">
          Suprimentos: marque as obras em que poderá cadastrar pagamentos e anexos. Engenheiros e administradores recebem acesso
          automaticamente às obras em que forem definidos como responsáveis; marque aqui apenas vínculos adicionais. O Financeiro
          tem acesso a todas.
        </p>
        {obras.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhuma obra cadastrada ainda.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {obras.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="obras" value={o.id} /> {o.nome}
              </label>
            ))}
          </div>
        )}
      </Cartao>
      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
      <Botao type="submit" disabled={pendente}>
        {pendente ? "Criando…" : "Criar usuário"}
      </Botao>
    </form>
  );
}
