import type { Metadata } from "next";
import { SelecaoLote, type ItemAssinavel } from "@/components/assinatura";
import { Cabecalho, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Aprovações e assinaturas" };

export default async function AprovacoesPage() {
  const u = await exigirPerfil("engenheiro", "administrador");
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("minhas_pendencias")
    .select("id, numero, versao, favorecido, descricao, valor, vencimento, status, obra:obras(nome), documentos(id, ativo, tipo)")
    .order("vencimento");
  if (error) throw new Error(error.message);

  const itens: ItemAssinavel[] = (data ?? []).map((p) => ({
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
