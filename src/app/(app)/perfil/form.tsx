"use client";

import { useState } from "react";
import { Aviso, Botao, Campo } from "@/components/ui";
import { criarClienteNavegador } from "@/lib/supabase/navegador";
import { formatoImagem } from "@/lib/imagem-pdf";
import { useRouter } from "next/navigation";

export function FormAssinatura({ userId }: { userId: string }) {
  const router = useRouter();
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");

  async function enviar() {
    if (!arquivo) return setErro("Escolha a imagem da assinatura.");
    if (!["image/png", "image/jpeg"].includes(arquivo.type)) return setErro("Use uma imagem PNG ou JPG.");
    if (arquivo.size > 2 * 1024 * 1024) return setErro("A imagem deve ter até 2 MB.");
    setErro("");
    setEnviando(true);
    try {
      const sb = criarClienteNavegador();
      const formato = formatoImagem(new Uint8Array(await arquivo.slice(0, 8).arrayBuffer()));
      if (!formato) throw new Error("o arquivo não é uma imagem PNG ou JPG válida");
      const ext = formato === "png" ? "png" : "jpg";
      const caminho = `${userId}/assinatura.${ext}`;
      const { error } = await sb.storage.from("assinaturas").upload(caminho, arquivo, { upsert: true, contentType: formato === "png" ? "image/png" : "image/jpeg" });
      if (error) throw new Error(error.message);
      const { error: e2 } = await sb.rpc("definir_assinatura", { p_path: caminho });
      if (e2) throw new Error(e2.message);
      setOk("Assinatura salva. Ela já aparece nos documentos que você for assinar.");
      setArquivo(null);
      router.refresh();
    } catch (e) {
      setErro(`Não foi possível salvar: ${(e as Error).message}`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-4">
      {ok && <Aviso tipo="sucesso">{ok}</Aviso>}
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      <Campo rotulo="Imagem da assinatura (PNG ou JPG)" ajuda="Dica: assine em papel branco, digitalize ou fotografe com boa luz e use fundo branco ou transparente.">
        <input type="file" accept="image/png,image/jpeg" className="campo" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
      </Campo>
      <Botao onClick={enviar} disabled={enviando || !arquivo}>{enviando ? "Salvando…" : "Salvar assinatura"}</Botao>
    </div>
  );
}
