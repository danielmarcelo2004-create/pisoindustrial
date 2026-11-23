import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Cartao, Selo, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { atualizarCategoria, criarCategoria } from "./actions";

export const metadata: Metadata = { title: "Categorias" };

export default async function CategoriasPage({ searchParams }: PageProps<"/categorias">) {
  await exigirPerfil("financeiro", "administrador_master");
  const tipo = (await searchParams).tipo === "receita" ? "receita" : "despesa";
  const supabase = await createClient();
  const { data: categorias } = await supabase.from("categorias").select("id, nome, ativo").eq("tipo", tipo).order("nome");

  return (
    <>
      <Cabecalho titulo="Categorias" subtitulo={tipo === "receita" ? "Categorias de receita usadas nas contas a receber" : "Categorias de despesa usadas no cadastro de pagamentos e nos relatórios"} />
      <nav className="mb-4 flex gap-1 border-b border-slate-200 text-sm" aria-label="Tipo de categoria">
        {(["despesa", "receita"] as const).map((t) => (
          <Link
            key={t}
            href={t === "receita" ? "/categorias?tipo=receita" : "/categorias"}
            aria-current={tipo === t ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 ${tipo === t ? "border-sky-700 font-semibold text-sky-800" : "border-transparent text-slate-600 hover:text-slate-800"}`}
          >
            {t === "despesa" ? "Despesas" : "Receitas"}
          </Link>
        ))}
      </nav>
      <Cartao titulo={tipo === "receita" ? "Nova categoria de receita" : "Nova categoria"} className="mb-4">
        <FormAcao action={criarCategoria} enviar="Cadastrar" limparAoConcluir className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tipo" value={tipo} />
          <input name="nome" required maxLength={120} placeholder={tipo === "receita" ? "Ex.: Medição de obra, Aporte, Reembolso" : "Ex.: Aluguel de equipamentos"} className="campo sm:max-w-md" aria-label="Nome da categoria" />
        </FormAcao>
      </Cartao>
      <Cartao semPadding>
        {!categorias?.length ? (
          <Vazio>Nenhuma categoria cadastrada.</Vazio>
        ) : (
          <ul className="divide-y divide-slate-100">
            {categorias.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <details>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm">
                    <span className="font-medium">{c.nome}</span>
                    {!c.ativo && <Selo cor="cinza">Desativada</Selo>}
                    <span className="ml-auto text-xs text-marca-700">Editar</span>
                  </summary>
                  <div className="mt-3">
                    <FormAcao action={atualizarCategoria.bind(null, c.id)} enviar="Salvar" className="flex flex-wrap items-center gap-3">
                      <input name="nome" required defaultValue={c.nome} maxLength={120} className="campo sm:max-w-md" aria-label={`Nome de ${c.nome}`} />
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" name="ativo" defaultChecked={c.ativo} /> Ativa
                      </label>
                    </FormAcao>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Cartao>
    </>
  );
}
