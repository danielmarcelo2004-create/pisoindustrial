"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { soDigitos } from "@/lib/formato";
import { UFS } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function salvarFornecedor(id: string | null, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const doc = soDigitos(t(fd, "cpf_cnpj"));
  const uf = t(fd, "uf").toUpperCase();
  if (!t(fd, "nome")) return { erro: "Informe o nome / razão social." };
  if (doc && doc.length !== 11 && doc.length !== 14) return { erro: "CPF deve ter 11 dígitos e CNPJ 14 dígitos." };
  if (uf && !UFS.includes(uf)) return { erro: "UF inválida." };

  const dados = {
    nome: t(fd, "nome"),
    cpf_cnpj: doc || null,
    email: t(fd, "email") || null,
    telefone: t(fd, "telefone") || null,
    cidade: t(fd, "cidade") || null,
    uf: uf || null,
    chave_pix: t(fd, "chave_pix") || null,
    banco: t(fd, "banco") || null,
    agencia: t(fd, "agencia") || null,
    conta: t(fd, "conta") || null,
    observacoes: t(fd, "observacoes") || null,
    ativo: id ? fd.get("ativo") === "on" : true,
  };

  const supabase = await createClient();
  if (id) {
    const { error } = await supabase.from("fornecedores").update(dados).eq("id", id);
    if (error) return { erro: mensagemErro(error) };
    revalidatePath("/fornecedores", "layout");
    return { ok: "Fornecedor atualizado." };
  }
  const { data, error } = await supabase.from("fornecedores").insert(dados).select("id").single();
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/fornecedores");
  redirect(`/fornecedores/${data.id}?criado=1`);
}
