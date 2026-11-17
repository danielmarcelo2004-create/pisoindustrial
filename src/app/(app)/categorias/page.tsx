import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Cartao, Selo, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { atualizarCategoria, criarCategoria } from "./actions";

export const metadata: Metadata = { title: "Categorias" };

export default async function CategoriasPage() {
  await exigirPerfil("financeiro", "administrador_master");
  const supabase = await createClient();
  const { data: categorias } = await supabase.from("categorias").select("id, nome, ativo").order("nome");

  return (
    <>
      <Cabecalho titulo="Categorias" subtitulo="Categorias de despesa usadas no cadastro de pagamentos e nos relatórios" />
      <Cartao titulo="Nova categoria" className="mb-4">
        <FormAcao action={criarCategoria} enviar="Cadastrar" limparAoConcluir className="flex flex-wrap items-end gap-2">
          <input name="nome" required maxLength={120} placeholder="Ex.: Aluguel de equipamentos" className="campo sm:max-w-md" aria-label="Nome da categoria" />
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
