import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { fornecedoresAtivos, obrasParaCadastro } from "@/lib/consultas/cadastros";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { categoriasAtivas } from "@/lib/consultas/categorias";
import { FLUXOS, FORMAS_PAGAMENTO_ATUAIS, type FormaPagamento } from "@/lib/rotulos";
import { CamposPagamento } from "../campos";
import { criarPagamento } from "../actions";
import { salvarOP } from "../../ops/actions";
import { assinaturaDoUsuario } from "../../ops/assinatura-usuario";
import { TipoPagamento } from "./tipo-pagamento";
import { CampoArquivos } from "@/components/campo-arquivos";
import { RepeticaoDespesa } from "@/components/repeticao-despesa";

export const metadata: Metadata = { title: "Novo pagamento" };

const ACEITOS = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.xml";

export default async function NovoPagamentoPage({ searchParams }: PageProps<"/pagamentos/novo">) {
  const u = await exigirPerfil("financeiro", "suprimentos", "engenheiro");
  const sp = await searchParams;
  const ehEngenheiro = u.perfil === "engenheiro";
  const podeAdicionarCategoria = u.perfil === "financeiro";
  const [obras, fornecedores, obrasOP, assinaturaUrl, categorias] = await Promise.all([
    ehEngenheiro ? Promise.resolve([]) : obrasParaCadastro(u),
    ehEngenheiro ? Promise.resolve([]) : fornecedoresAtivos(),
    obrasParaOP(),
    assinaturaDoUsuario(u.id, ehEngenheiro),
    categoriasAtivas(),
  ]);
  // Engenheiro só solicita formas que não são boleto (Ordem de Pagamento).
  const formas: FormaPagamento[] = ehEngenheiro ? FORMAS_PAGAMENTO_ATUAIS : ["boleto", ...FORMAS_PAGAMENTO_ATUAIS];
  const obraPadrao = typeof sp.obra === "string" ? sp.obra : "";
  const podeAssinarCadastro = u.perfil === "financeiro" || u.perfil === "suprimentos";
  const texto = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const padraoCampos = {
    descricao: texto("descricao"),
    vencimento: texto("vencimento") || null,
    valor: texto("valor") || null,
    categoria_id: texto("categoria") || null,
  };

  return (
    <>
      <Cabecalho titulo="Novo pagamento" voltar={{ href: "/pagamentos", rotulo: "Pagamentos" }} />
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
                <CamposPagamento fornecedores={fornecedores} padrao={padraoCampos} parcelar formaFixa="boleto" categorias={categorias} podeAdicionarCategoria={podeAdicionarCategoria} />
              </Cartao>
              <Cartao titulo="Repetição">
                <RepeticaoDespesa />
              </Cartao>
              {podeAssinarCadastro && (
                <Cartao titulo="Assinatura do cadastro">
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" name="assinar" className="mt-0.5" />
                    <span>
                      Assinar como quem cadastrou. É só uma marca no pagamento, não é etapa de aprovação.
                    </span>
                  </label>
                </Cartao>
              )}
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
          podeAssinar: u.perfil === "financeiro" || u.perfil === "suprimentos",
          ehEngenheiro,
          assinaturaUrl,
          categorias,
          podeAdicionarCategoria,
        }}
      />
    </>
  );
}
