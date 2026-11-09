"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { lerNfseTexto, lerNfseXml, type DadosNota } from "@/lib/notas-contabeis";
import { extrairTextoPdf } from "@/lib/pdf-texto";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

const EXTENSOES: Record<string, string> = { pdf: "application/pdf", xml: "application/xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

/** Anexa uma nota de medição (sem pagamento). Os dados lidos do arquivo completam o que o usuário não preencheu. */
export async function anexarNotaMedicao(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const obra = t(fd, "obra_id");
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo da medição." };

  const arquivo = fd.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) return { erro: "Escolha o arquivo da nota de medição." };
  const ext = arquivo.name.split(".").pop()?.toLowerCase() ?? "";
  if (!EXTENSOES[ext]) return { erro: "Envie um PDF, XML, PNG ou JPG." };
  if (arquivo.size > 25 * 1024 * 1024) return { erro: "O arquivo passa de 25 MB." };

  const valor = lerValor(t(fd, "valor"));
  const liquido = lerValor(t(fd, "valor_liquido"));
  if (valor === null || valor <= 0) return { erro: "Informe o valor total da nota." };
  if (liquido === null || liquido < 0) return { erro: "Informe o valor líquido da nota." };
  if (liquido > valor) return { erro: "O valor líquido não pode ser maior que o valor total." };

  const bytes = Buffer.from(await arquivo.arrayBuffer());
  // Dados do arquivo, quando a nota é legível. Campos preenchidos à mão têm prioridade.
  let lido: DadosNota | null = null;
  if (ext === "xml") lido = lerNfseXml(bytes.toString("utf8"));
  else if (ext === "pdf") lido = lerNfseTexto(await extrairTextoPdf(bytes));

  const caminho = `${obra}/medicoes/${randomUUID()}.${ext}`;
  const supabase = await createClient();
  const up = await supabase.storage.from("documentos").upload(caminho, bytes, { contentType: EXTENSOES[ext], upsert: false });
  if (up.error) return { erro: `Falha ao enviar o arquivo: ${mensagemErro(up.error)}` };

  const { error } = await supabase.rpc("registrar_nota_medicao", {
    p_obra_id: obra,
    p_storage_path: caminho,
    p_nome: arquivo.name.slice(0, 200),
    p_mime: EXTENSOES[ext],
    p_sha256: createHash("sha256").update(bytes).digest("hex"),
    p_dados: {
      valor,
      valor_liquido: liquido,
      numero: t(fd, "numero") || lido?.numero || undefined,
      prestador_documento: lido?.prestadorDocumento || undefined,
      prestador_nome: lido?.prestadorNome || undefined,
      data_emissao: lido?.dataEmissao || undefined,
      descricao: t(fd, "descricao") || undefined,
    },
  });
  if (error) return { erro: mensagemErro(error) };

  revalidatePath("/notas-medicao");
  return { ok: "Nota de medição anexada." };
}
