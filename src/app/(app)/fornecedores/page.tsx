import type { Metadata } from "next";
import Link from "next/link";
import { Cabecalho, Cartao, LinkBotao, Selo, Vazio, classeBotao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { cpfCnpj, soDigitos } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fornecedores" };

export default async function FornecedoresPage({ searchParams }: PageProps<"/fornecedores">) {
  await exigirPerfil("financeiro", "suprimentos");
  const sp = await searchParams;
  const busca = typeof sp.busca === "string" ? sp.busca.trim().replace(/[%,()*\\]/g, " ").trim() : "";
  const supabase = await createClient();
  let q = supabase.from("fornecedores").select("id, nome, cpf_cnpj, cidade, uf, telefone, ativo").order("nome").limit(500);
  if (busca) {
    const dig = soDigitos(busca);
    q = q.or(`nome.ilike.%${busca}%${dig.length >= 3 ? `,cpf_cnpj.like.%${dig}%` : ""}`);
  }
  const { data } = await q;

  return (
    <>
      <Cabecalho titulo="Fornecedores" acoes={<LinkBotao href="/fornecedores/novo">+ Novo fornecedor</LinkBotao>} />
      <Cartao className="mb-4">
        <form className="flex gap-2" method="get">
          <input name="busca" defaultValue={busca} placeholder="Buscar por nome ou CPF/CNPJ…" className="campo" />
          <button className={classeBotao("primario")}>Buscar</button>
        </form>
      </Cartao>
      <Cartao semPadding>
        {!data?.length ? (
          <Vazio>Nenhum fornecedor encontrado.</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>CPF/CNPJ</th>
                  <th>Local</th>
                  <th>Telefone</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Link href={`/fornecedores/${f.id}`} className="font-medium text-marca-700 hover:underline">
                        {f.nome}
                      </Link>
                    </td>
                    <td className="tabular-nums">{cpfCnpj(f.cpf_cnpj) || "—"}</td>
                    <td>{f.cidade ? `${f.cidade}/${f.uf ?? ""}` : "—"}</td>
                    <td>{f.telefone ?? "—"}</td>
                    <td>{!f.ativo && <Selo>Inativo</Selo>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </>
  );
}
