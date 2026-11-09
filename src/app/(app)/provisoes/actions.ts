"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Soma meses a uma data AAAA-MM-DD, mantendo o dia (ou o último dia do mês, quando não existe). */
function somarMeses(iso: string, meses: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimoDia);
  return new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), dia)).toISOString().slice(0, 10);
}

export async function criarProvisao(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const obra = t(fd, "obra_id");
  const descricao = t(fd, "descricao");
  const venc = t(fd, "vencimento");
  const valorTxt = t(fd, "valor_estimado");
  const mesesTxt = t(fd, "meses") || "1";
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo." };
  if (!descricao) return { erro: "Informe a descrição (ex.: Conta de luz da casa alugada)." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const meses = Number(mesesTxt);
  if (!Number.isInteger(meses) || meses < 1 || meses > 60) return { erro: "Informe de 1 a 60 meses." };
  if (meses > 1 && !venc) return { erro: "Para várias parcelas, informe o primeiro vencimento." };
  const valor = valorTxt ? lerValor(valorTxt) : null;
  if (valorTxt && valor === null) return { erro: "Valor estimado inválido." };

  // Uma linha por parcela: vencimento mensal a partir do primeiro, com a mesma descrição numerada.
  const linhas = Array.from({ length: meses }, (_, i) => {
    const vencParcela = venc ? somarMeses(venc, i) : null;
    return {
      obra_id: obra,
      descricao: meses > 1 ? `${descricao} (${i + 1}/${meses})` : descricao,
      mes_referencia: vencParcela ? vencParcela.slice(0, 7) : null,
      vencimento: vencParcela,
      valor_estimado: valor,
      observacoes: t(fd, "observacoes") || null,
    };
  });

  const supabase = await createClient();
  const { error } = await supabase.from("provisoes").insert(linhas);
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/agenda");
  return {
    ok: meses > 1
      ? `${meses} provisões criadas, uma por mês a partir de ${venc.split("-").reverse().join("/")}. Elas aparecem na agenda, mas não entram nos totais a pagar.`
      : "Provisão registrada. Ela aparece na agenda, mas não entra nos totais a pagar.",
  };
}

export async function alterarProvisao(id: string, status: "convertida" | "cancelada", _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Provisão não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.from("provisoes").update({ status }).eq("id", id);
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/agenda");
  return { ok: status === "convertida" ? "Provisão marcada como lançada." : "Provisão cancelada." };
}
