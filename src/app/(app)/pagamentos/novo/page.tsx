import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fornecedoresAtivos, obrasParaCadastro } from "@/lib/consultas/cadastros";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { categoriasAtivas } from "@/lib/consultas/categorias";
import { contasBancariasAtivas } from "@/lib/consultas/contas-bancarias";
import { FLUXOS, FORMAS_PAGAMENTO_ATUAIS, type FormaPagamento } from "@/lib/rotulos";
import { CamposPagamento } from "../campos";
import { criarPagamento } from "../actions";
import { salvarOP } from "../../ops/actions";
import { assinaturaDoUsuario } from "../../ops/assinatura-usuario";
import { TipoPagamento } from "./tipo-pagamento";
import { CampoArquivos } from "@/components/campo-arquivos";
import { RepeticaoDespesa } from "@/components/repeticao-despesa";

export const metadata: Metadata = { title: "Nova despesa" };

const ACEITOS = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.xml";

export default async function NovoPagamentoPage({ searchParams }: PageProps<"/pagamentos/novo">) {
  const u = await exigirPerfil("financeiro", "suprimentos", "engenheiro");
  const sp = await searchParams;
  const ehEngenheiro = u.perfil === "engenheiro";
  const podeAdicionarCategoria = u.perfil === "financeiro";
  const [obras, fornecedores, obrasOP, assinaturaUrl, categorias, contasBancarias] = await Promise.all([
    ehEngenheiro ? Promise.resolve([]) : obrasParaCadastro(u),
    ehEngenheiro ? Promise.resolve([]) : fornecedoresAtivos(),
    obrasParaOP(),
    assinaturaDoUsuario(u.id, ehEngenheiro),
    categoriasAtivas(),
    contasBancariasAtivas(),
  ]);
  // Engenheiro só solicita formas que não são boleto (Ordem de Pagamento).
  const formas: FormaPagamento[] = ehEngenheiro ? FORMAS_PAGAMENTO_ATUAIS : ["boleto", ...FORMAS_PAGAMENTO_ATUAIS];
  const texto = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  // "Clonar lançamento": abre o formulário com os dados de um pagamento existente (sem vencimento e sem anexos).
  const clonarId = /^[0-9a-f-]{36}$/i.test(texto("clonar")) ? texto("clonar") : "";
  const { data: origem } = clonarId
    ? await (await createClient())
        .from("pagamentos")
        .select("numero, obra_id, fornecedor_id, favorecido, descricao, valor, categoria_id, conta_bancaria_id, numero_documento, observacoes")
        .eq("id", clonarId)
        .maybeSingle()
    : { data: null };
  // "Lançar despesa" de uma provisão: abre preenchido; ao salvar, a provisão é marcada como lançada.
  const provisaoId = /^[0-9a-f-]{36}$/i.test(texto("provisao")) ? texto("provisao") : "";
  const { data: prov } = provisaoId
    ? await (await createClient()).from("provisoes").select("id, descricao, obra_id, vencimento, valor_estimado, categoria_id, status, obra:obras(nome)").eq("id", provisaoId).maybeSingle()
    : { data: null };
  const provAberta = prov && prov.status === "provisionada" ? prov : null;
  const obraPadrao = origem?.obra_id ?? provAberta?.obra_id ?? (typeof sp.obra === "string" ? sp.obra : "");
  const padraoCampos = origem
    ? {
        fornecedor_id: origem.fornecedor_id,
        favorecido: origem.favorecido,
        descricao: origem.descricao,
        valor: origem.valor,
        categoria_id: origem.categoria_id,
        conta_bancaria_id: origem.conta_bancaria_id,
        observacoes: origem.observacoes,
        vencimento: null,
      }
    : provAberta
      ? {
          descricao: provAberta.descricao,
          vencimento: provAberta.vencimento,
          valor: provAberta.valor_estimado === null ? null : String(provAberta.valor_estimado),
          categoria_id: provAberta.categoria_id,
        }
      : {
          descricao: texto("descricao"),
          vencimento: texto("vencimento") || null,
          valor: texto("valor") || null,
          categoria_id: texto("categoria") || null,
        };

  return (
    <>
      <Cabecalho titulo={origem ? `Nova despesa (cópia do nº ${origem.numero})` : "Nova despesa"} voltar={{ href: "/pagamentos", rotulo: "Contas a pagar" }} />
      {prov && !provAberta && (
        <div className="mb-4">
          <Aviso tipo="alerta">A provisão “{prov.descricao}” já foi lançada ou cancelada. Esta despesa será cadastrada sem ligação com ela.</Aviso>
        </div>
      )}
      {provAberta && (
        <div className="mb-4" data-lancando-provisao>
          <Aviso tipo="info">
            Lançando a provisão <strong>{provAberta.descricao}</strong> ({provAberta.obra?.nome}). Informe o fornecedor ou favorecido, confira o valor real, anexe o boleto ou a nota (ou preencha a Ordem de Pagamento) e salve: a provisão é marcada como lançada sozinha.
          </Aviso>
        </div>
      )}
      {origem && (
        <div className="mb-4">
          <Aviso tipo="info">Dados copiados do pagamento nº {origem.numero}. Informe o vencimento e anexe o boleto ou a nota fiscal desta nova despesa.</Aviso>
        </div>
      )}
      <TipoPagamento
        formas={formas}
        formaInicial={formas[0]}
        formBoleto={
          obras.length === 0 ? (
            <Aviso tipo="alerta">Você ainda não tem permissão para cadastrar pagamentos com boleto em nenhuma obra ativa. Solicite acesso ao Financeiro.</Aviso>
          ) : (
            <FormAcao
              action={criarPagamento}
              enviar="Cadastrar e encaminhar"
              pendente="Enviando…"
              limparErroAoMudar={{ campos: ["boleto", "nota_fiscal"], trecho: "Anexe um boleto ou nota fiscal" }}
            >
              {provAberta && <input type="hidden" name="provisao_id" value={provAberta.id} />}
              <Cartao titulo="Centro de custo">
                <Campo rotulo="Centro de custo" obrigatorio ajuda="O pagamento seguirá o fluxo de aprovação configurado para a obra.">
                  <select name="obra_id" required defaultValue={obraPadrao} className="campo">
                    <option value="">Selecione…</option>
                    {obras.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.nome} — {o.cidade}/{o.uf} · {FLUXOS[o.fluxo].rotulo.split(" — ")[1]}
                      </option>
                    ))}
                  </select>
                </Campo>
              </Cartao>
              <Cartao titulo="Dados do pagamento">
                <CamposPagamento podeAdicionarFornecedor={u.perfil === "financeiro" || u.perfil === "suprimentos"} fornecedores={fornecedores} padrao={padraoCampos} parcelar formaFixa="boleto" categorias={categorias} podeAdicionarCategoria={podeAdicionarCategoria} contasBancarias={contasBancarias} podeCadastrarConta={u.perfil === "financeiro"} />
              </Cartao>
              <Cartao titulo="Repetição">
                <RepeticaoDespesa />
              </Cartao>
              <Cartao titulo="Documentos">
                <p className="mb-3 text-sm text-slate-600">
                  Obrigatório: anexe o boleto ou a nota fiscal. É o documento que o engenheiro assina antes da aprovação.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Campo rotulo="Boleto">
                    <CampoArquivos nome="boleto" accept={ACEITOS} />
                  </Campo>
                  <Campo rotulo="Nota fiscal" ajuda="Prefira o XML da NF-e, quando houver.">
                    <CampoArquivos nome="nota_fiscal" accept={ACEITOS} />
                  </Campo>
                  <Campo rotulo="Outros documentos">
                    <CampoArquivos nome="outros" accept={ACEITOS} />
                  </Campo>
                </div>
                <p className="mt-2 text-xs text-slate-500">Pode anexar vários arquivos em cada campo (ex.: duas notas fiscais de uma mesma duplicata). PDF, imagem ou XML, até 25 MB cada. Também é possível anexar depois.</p>
              </Cartao>
            </FormAcao>
          )
        }
        op={{
          action: salvarOP.bind(null, null),
          obras: obrasOP,
          ehEngenheiro,
          assinaturaUrl,
          categorias,
          podeAdicionarCategoria,
          contasBancarias,
          podeCadastrarConta: u.perfil === "financeiro",
          provisaoId: provAberta?.id,
          padrao: provAberta
            ? { obra_id: provAberta.obra_id, descricao: provAberta.descricao, vencimento: provAberta.vencimento ?? undefined, categoria_id: provAberta.categoria_id ?? undefined }
            : undefined,
        }}
      />
    </>
  );
}
