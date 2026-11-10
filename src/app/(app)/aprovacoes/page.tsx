import type { Metadata } from "next";
import { SelecaoLote, type ItemAssinavel } from "@/components/assinatura";
import { Cabecalho, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Aprovações e assinaturas" };

export default async function AprovacoesPage() {
  const u = await exigirPerfil("engenheiro", "administrador", "administrador_master");
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("minhas_pendencias")
    .select("id, numero, versao, favorecido, descricao, valor, vencimento, status, obra:obras(nome), documentos(id, ativo, tipo, mime_type, enviado_por, pagamento_versao)")
    .order("vencimento");
  if (error) throw new Error(error.message);

  // Só o que pede aprovação/assinatura nesta tela. Pagamentos já liberados (aguardando pagamento) são de quem dá baixa.
  const aprovar = (data ?? []).filter((p) => p.status === "aguardando_engenheiro" || p.status === "aguardando_administrador");
  const itens: ItemAssinavel[] = aprovar.map((p) => ({
    id: p.id,
    numero: p.numero,
    versao: p.versao,
    favorecido: p.favorecido,
    descricao: p.descricao,
    valor: Number(p.valor),
    vencimento: p.vencimento,
    obra: p.obra?.nome ?? "",
    etapa: p.status === "aguardando_engenheiro" ? "Engenheiro" : "Administrador",
    documentos: (p.documentos ?? []).filter((d) => d.ativo && d.tipo !== "comprovante").length,
    temOP: (p.documentos ?? []).some((d) => d.ativo && d.tipo === "ordem_pagamento"),
    temDocAssinavel: (p.documentos ?? []).some(
      (d) => d.ativo && d.tipo !== "comprovante" && d.tipo !== "ordem_pagamento" && d.tipo !== "documento_assinado" &&
        ["application/pdf", "image/png", "image/jpeg"].includes(d.mime_type ?? ""),
    ),
    faltaAssinaturaDoc:
      (p.documentos ?? []).some(
        (d) => d.ativo && d.tipo !== "comprovante" && d.tipo !== "ordem_pagamento" && d.tipo !== "documento_assinado" &&
          ["application/pdf", "image/png", "image/jpeg"].includes(d.mime_type ?? ""),
      ) &&
      !(p.documentos ?? []).some((d) => d.ativo && d.tipo === "documento_assinado" && d.enviado_por === u.id && d.pagamento_versao === p.versao),
  }));

  return (
    <>
      <Cabecalho
        titulo="Aprovações e assinaturas"
        subtitulo={
          u.perfil === "engenheiro"
            ? "Documentos das suas obras aguardando conferência e assinatura do engenheiro"
            : "Documentos das suas obras aguardando conferência e assinatura do administrador"
        }
      />
      <Cartao semPadding>
        <SelecaoLote itens={itens} />
      </Cartao>
    </>
  );
}
