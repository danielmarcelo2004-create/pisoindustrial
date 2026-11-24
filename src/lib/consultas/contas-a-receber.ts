// Contas a receber: recebimentos (nascem na conciliação) + transferências que entraram nas contas da empresa
// (aparecem como "Recebido", marcadas, fora dos totais de receita).
import "server-only";
import { createClient } from "@/lib/supabase/server";

export type FiltroCartaoReceber = "" | "vencidos" | "hoje" | "avencer" | "recebidos";
export type SituacaoReceber = "recebido" | "vencido" | "hoje" | "a_receber" | "cancelado";

export type LinhaReceber = {
  chave: string; // rec:<id> ou transf:<id>
  tipo: "recebimento" | "transferencia";
  id: string;
  numero: number | null;
  cliente: string;
  descricao: string;
  obra: string | null;
  categoria: string | null;
  conta: string | null;
  vencimento: string;
  recebidoEm: string | null;
  valor: number;
  aReceber: number;
  situacao: SituacaoReceber;
  lancadoConciliacao: boolean;
  temNota: boolean;
};

export type FiltrosReceber = {
  de: string;
  ate: string;
  periodo: string;
  busca: string;
  obra: string;
  categoria: string;
  conta: string;
  cancelados: boolean;
  semtransf: boolean;
  cartao: FiltroCartaoReceber;
};

const um = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);

export function situacaoReceber(status: string, vencimento: string, hoje: string): SituacaoReceber {
  if (status === "cancelado") return "cancelado";
  if (status === "recebido") return "recebido";
  if (vencimento < hoje) return "vencido";
  if (vencimento === hoje) return "hoje";
  return "a_receber";
}

export async function listarRecebimentos(f: FiltrosReceber, hoje: string, verTransferencias: boolean) {
  const supabase = await createClient();
  let q = supabase
    .from("recebimentos")
    .select("id, numero, cliente, descricao, valor, vencimento, status, recebido_em, valor_recebido, lancado_conciliacao, nota_medicao_id, obra:obras(nome), categoria:categorias(nome), conta:contas_bancarias(nome)")
    .order("vencimento", { ascending: true })
    .order("numero", { ascending: true })
    .limit(3000);
  if (f.periodo !== "todos") q = q.gte("vencimento", f.de).lte("vencimento", f.ate);
  if (f.obra) q = q.eq("obra_id", f.obra);
  if (f.categoria) q = q.eq("categoria_id", f.categoria);
  if (f.conta) q = q.eq("conta_bancaria_id", f.conta);
  if (!f.cancelados) q = q.neq("status", "cancelado");
  const { data } = await q;
  let linhas: LinhaReceber[] = (data ?? []).map((r) => {
    const situacao = situacaoReceber(r.status, r.vencimento, hoje);
    return {
      chave: `rec:${r.id}`,
      tipo: "recebimento",
      id: r.id,
      numero: Number(r.numero),
      cliente: r.cliente,
      descricao: r.descricao,
      obra: um(r.obra as { nome: string } | { nome: string }[] | null)?.nome ?? null,
      categoria: um(r.categoria as { nome: string } | { nome: string }[] | null)?.nome ?? null,
      conta: um(r.conta as { nome: string } | { nome: string }[] | null)?.nome ?? null,
      vencimento: r.vencimento,
      recebidoEm: r.recebido_em,
      valor: Number(r.valor),
      aReceber: r.status === "aberto" ? Number(r.valor) : 0,
      situacao,
      lancadoConciliacao: r.lancado_conciliacao,
      temNota: Boolean(r.nota_medicao_id),
    };
  });

  // Transferências que entraram numa conta: só quem vê o banco (Financeiro/master), sem filtro de centro de custo/categoria
  if (verTransferencias && !f.semtransf && !f.obra && !f.categoria && !f.cancelados) {
    let t = supabase
      .from("transferencias")
      .select("id, valor, data, descricao, conta_destino, origem:contas_bancarias!transferencias_conta_origem_fkey(nome), destino:contas_bancarias!transferencias_conta_destino_fkey(nome)")
      .order("data")
      .limit(2000);
    if (f.periodo !== "todos") t = t.gte("data", f.de).lte("data", f.ate);
    if (f.conta) t = t.eq("conta_destino", f.conta);
    const { data: tr } = await t;
    linhas = linhas.concat(
      (tr ?? []).map((x) => ({
        chave: `transf:${x.id}`,
        tipo: "transferencia" as const,
        id: x.id,
        numero: null,
        cliente: `Transferência de ${um(x.origem as { nome: string } | { nome: string }[] | null)?.nome ?? "outra conta"}`,
        descricao: x.descricao,
        obra: null,
        categoria: null,
        conta: um(x.destino as { nome: string } | { nome: string }[] | null)?.nome ?? null,
        vencimento: x.data,
        recebidoEm: x.data,
        valor: Number(x.valor),
        aReceber: 0,
        situacao: "recebido" as const,
        lancadoConciliacao: false,
        temNota: false,
      })),
    );
    linhas.sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : 0));
  }

  const busca = f.busca.trim().toLocaleLowerCase("pt-BR");
  if (busca) {
    const n = Number(busca.replace(/^n[ºo°]?\s*/, ""));
    linhas = linhas.filter((l) => l.cliente.toLocaleLowerCase("pt-BR").includes(busca) || l.descricao.toLocaleLowerCase("pt-BR").includes(busca) || (Number.isInteger(n) && n > 0 && l.numero === n));
  }

  // Totais (sem transferências e sem cancelados), antes do filtro do cartão
  const receitas = linhas.filter((l) => l.tipo === "recebimento" && l.situacao !== "cancelado");
  const soma = (xs: LinhaReceber[], campo: "valor" | "aReceber" = "valor") => ({ qtd: xs.length, valor: Math.round(xs.reduce((s, l) => s + l[campo], 0) * 100) / 100 });
  const totais = {
    vencidos: soma(receitas.filter((l) => l.situacao === "vencido"), "aReceber"),
    hoje: soma(receitas.filter((l) => l.situacao === "hoje"), "aReceber"),
    avencer: soma(receitas.filter((l) => l.situacao === "a_receber"), "aReceber"),
    recebidos: soma(receitas.filter((l) => l.situacao === "recebido")),
    total: soma(receitas),
    transferencias: soma(linhas.filter((l) => l.tipo === "transferencia")),
  };

  const porCartao: Record<FiltroCartaoReceber, (l: LinhaReceber) => boolean> = {
    "": () => true,
    vencidos: (l) => l.situacao === "vencido",
    hoje: (l) => l.situacao === "hoje",
    avencer: (l) => l.situacao === "a_receber",
    recebidos: (l) => l.situacao === "recebido",
  };
  return { linhas: linhas.filter(porCartao[f.cartao]), totais };
}

/** Um recebimento com a nota de medição anexada e as notas da obra que ainda podem ser anexadas. */
export async function recebimento(id: string) {
  const supabase = await createClient();
  const { data: r } = await supabase
    .from("recebimentos")
    .select("*, obra:obras(id, nome, cliente), categoria:categorias(nome), conta:contas_bancarias(nome), nota:notas_medicao(id, numero, nome_arquivo, valor, valor_liquido, data_emissao, prestador_nome)")
    .eq("id", id)
    .maybeSingle();
  if (!r) return null;
  const [{ data: linha }, { data: notas }, { data: usadas }, { data: impostos }] = await Promise.all([
    supabase.from("extrato_linhas").select("id, data, descricao, valor, conta_id").eq("recebimento_id", id).maybeSingle(),
    supabase.from("notas_medicao").select("id, numero, nome_arquivo, valor, valor_liquido, data_emissao").eq("obra_id", r.obra_id).order("criada_em", { ascending: false }).limit(200),
    supabase.from("recebimentos").select("nota_medicao_id").not("nota_medicao_id", "is", null),
    supabase.from("pagamentos").select("id, numero, descricao, valor, status, pago_em, imposto_medicao").eq("recebimento_id", id).order("imposto_medicao"),
  ]);
  const ocupadas = new Set((usadas ?? []).map((x) => x.nota_medicao_id));
  return {
    ...r,
    obra: um(r.obra as { id: string; nome: string; cliente: string | null } | { id: string; nome: string; cliente: string | null }[] | null),
    categoria: um(r.categoria as { nome: string } | { nome: string }[] | null),
    conta: um(r.conta as { nome: string } | { nome: string }[] | null),
    nota: um(r.nota as { id: string; numero: string | null; nome_arquivo: string; valor: number; valor_liquido: number; data_emissao: string | null; prestador_nome: string | null } | null),
    linha,
    impostos: impostos ?? [],
    notasDisponiveis: (notas ?? []).filter((n) => !ocupadas.has(n.id) || n.id === r.nota_medicao_id),
  };
}
