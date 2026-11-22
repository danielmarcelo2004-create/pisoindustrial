import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { fornecedoresAtivos, obrasParaCadastro } from "@/lib/consultas/cadastros";
import { createClient } from "@/lib/supabase/server";
import { CamposPagamento } from "../../campos";
import { contasBancariasAtivas } from "@/lib/consultas/contas-bancarias";
import { atualizarPagamento } from "../../actions";
import { EditorParcelas } from "./editor-parcelas";

export const metadata: Metadata = { title: "Editar pagamento" };

export default async function EditarPagamentoPage({ params }: PageProps<"/pagamentos/[id]/editar">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const u = await getUsuario();
  const supabase = await createClient();
  const { data: p } = await supabase.from("pagamentos").select("*, obra:obras(nome)").eq("id", id).maybeSingle();
  if (!p) notFound();
  const { data: categorias } = await supabase
    .from("categorias")
    .select("id, nome")
    .or(p.categoria_id ? `ativo.eq.true,id.eq.${p.categoria_id}` : "ativo.eq.true")
    .order("nome");
  const { data: pode } = await supabase.rpc("pode_atuar_obra", { p_obra_id: p.obra_id });
  const podeFechado = u.perfil === "financeiro" || u.perfil === "suprimentos";
  const fechado = p.status === "pago" || p.status === "aguardando_pagamento";
  if (p.status === "cancelado" || !pode || (p.status === "pago" && !podeFechado)) redirect(`/pagamentos/${id}`);
  const obrasDisponiveis = await obrasParaCadastro(u);

  const [fornecedores, { count: assinaturas }, { count: repeticoes }, { data: boletos }, { data: parcelas }] = await Promise.all([
    fornecedoresAtivos(),
    supabase
      .from("assinaturas")
      .select("id", { count: "exact", head: true })
      .eq("pagamento_id", id)
      .eq("pagamento_versao", p.versao)
      .eq("decisao", "aprovado"),
    supabase.from("provisoes").select("id", { count: "exact", head: true }).eq("pagamento_origem_id", id).eq("status", "provisionada"),
    supabase.from("documentos").select("id, nome_arquivo").eq("pagamento_id", id).eq("tipo", "boleto").eq("ativo", true),
    supabase.from("pagamento_parcelas").select("id, numero, vencimento, valor_base, status").eq("pagamento_id", id).order("numero"),
  ]);

  return (
    <>
      <Cabecalho titulo={`Editar pagamento nº ${p.numero}`} subtitulo={p.obra?.nome} voltar={{ href: `/pagamentos/${id}`, rotulo: "Voltar ao pagamento" }} />
      {!!assinaturas && (
        <div className="mb-4">
          <Aviso tipo="alerta">
            Este pagamento já foi assinado nesta versão. Alterar valor, vencimento, favorecido, descrição ou documento gera uma nova
            versão e reinicia o fluxo de assinaturas. A versão anterior fica preservada no histórico.
          </Aviso>
        </div>
      )}
      {fechado && (
        <div className="mb-4">
          <Aviso tipo="info">
            Pagamento já liberado ou pago: a alteração não pede nova aprovação, fica registrada no histórico e avisa o Financeiro.
            O motivo é obrigatório.
          </Aviso>
        </div>
      )}
      <FormAcao action={atualizarPagamento.bind(null, id)} enviar="Salvar alterações">
        <Cartao titulo="Centro de custo">
          <Campo rotulo="Centro de custo" obrigatorio ajuda="Você pode mover o pagamento para outro centro de custo que atende.">
            <select name="obra_id" required defaultValue={p.obra_id} className="campo">
              {[...(obrasDisponiveis ?? []), ...(obrasDisponiveis.some((o) => o.id === p.obra_id) ? [] : [{ id: p.obra_id, nome: p.obra?.nome ?? "Atual", cidade: "", uf: "", fluxo: "C" as const }])].map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome}
                </option>
              ))}
            </select>
          </Campo>
        </Cartao>
        <Cartao titulo="Dados do pagamento">
          <CamposPagamento fornecedores={fornecedores} padrao={p} pagamentoId={id} categorias={categorias ?? []} podeAdicionarCategoria={u.perfil === "financeiro" || u.perfil === "administrador_master"} contasBancarias={await contasBancariasAtivas()} podeCadastrarConta={u.perfil === "financeiro"} />
        </Cartao>
        {(parcelas?.length ?? 0) > 1 && (
          <Cartao titulo={`Parcelas (${parcelas!.length})`}>
            <EditorParcelas
              somenteLeitura={!(u.perfil === "financeiro" || p.created_by === u.id)}
              parcelas={parcelas!.map((x) => ({ id: x.id, numero: x.numero, vencimento: x.vencimento, valor: Number(x.valor_base), pago: x.status === "pago" }))}
            />
          </Cartao>
        )}
        {!!boletos?.length && (
          <Cartao titulo="Boleto">
            <p className="mb-3 text-sm text-slate-600">
              Boleto anexado: <strong>{boletos.map((b) => b.nome_arquivo).join(", ")}</strong>. Se o valor ou o vencimento mudou, anexe o
              boleto novo: o anterior fica no histórico como substituído. Sem o boleto novo, o pagamento fica marcado como
              “boleto desatualizado”.
            </p>
            <Campo rotulo="Boleto novo (opcional)">
              <input type="file" name="novo_boleto" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic" className="campo" />
            </Campo>
          </Cartao>
        )}
        {!!repeticoes && (
          <Cartao titulo="Repetições">
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="reajustar_serie" className="mt-0.5" />
              <span>
                Aplicar o novo valor também às {repeticoes} próxima(s) repetição(ões) em aberto deste lançamento
              </span>
            </label>
          </Cartao>
        )}
        <Cartao>
          <Campo rotulo="Motivo da alteração" obrigatorio={fechado} ajuda="Fica registrado no histórico do pagamento.">
            <input name="motivo" required={fechado} className="campo" maxLength={500} />
          </Campo>
        </Cartao>
      </FormAcao>
    </>
  );
}
