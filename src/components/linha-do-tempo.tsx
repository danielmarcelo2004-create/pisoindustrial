import { dataHora, moeda, data } from "@/lib/formato";
import { PERFIS, STATUS_PAGAMENTO, type Perfil, type StatusPagamento } from "@/lib/rotulos";
import { cx } from "@/components/ui";

export type EventoAuditoria = {
  id: number;
  created_at: string;
  user_nome: string | null;
  user_perfil: Perfil | null;
  acao: string;
  descricao: string | null;
  entidade?: string;
  dados_antes: unknown;
  dados_depois: unknown;
};

const ACOES: Record<string, { rotulo: string; cor: string }> = {
  criou: { rotulo: "Criou", cor: "bg-marca-500" },
  alterou: { rotulo: "Alterou", cor: "bg-amber-500" },
  anexou_documento: { rotulo: "Anexou documento", cor: "bg-sky-500" },
  substituiu_documento: { rotulo: "Substituiu documento", cor: "bg-amber-500" },
  assinou: { rotulo: "Assinou", cor: "bg-emerald-500" },
  rejeitou: { rotulo: "Rejeitou", cor: "bg-red-500" },
  reenviou: { rotulo: "Reenviou", cor: "bg-marca-500" },
  fluxo_reiniciado: { rotulo: "Fluxo reiniciado", cor: "bg-amber-500" },
  reencaminhou: { rotulo: "Reencaminhado", cor: "bg-slate-400" },
  baixa: { rotulo: "Pagamento efetuado", cor: "bg-emerald-600" },
  cancelou: { rotulo: "Cancelou", cor: "bg-slate-500" },
  removeu: { rotulo: "Removeu", cor: "bg-red-500" },
};

export const ROTULOS_CAMPOS: Record<string, string> = {
  valor: "Valor",
  valor_pago: "Valor pago",
  vencimento: "Vencimento",
  pago_em: "Pago em",
  favorecido: "Favorecido",
  descricao: "Descrição",
  fornecedor_id: "Fornecedor",
  forma_pagamento: "Forma de pagamento",
  numero_documento: "Nº documento",
  observacoes: "Observações",
  status: "Situação",
  versao: "Versão",
  fluxo: "Fluxo",
  nome: "Nome",
  telefone: "Telefone",
  perfil: "Perfil",
  ativo: "Ativo",
  troca_senha_pendente: "Troca de senha pendente",
  engenheiro_id: "Engenheiro",
  administrador_id: "Administrador",
  cidade: "Cidade",
  uf: "UF",
  codigo: "Código",
  cliente: "Cliente",
  endereco: "Endereço",
  cpf_cnpj: "CPF/CNPJ",
  email: "E-mail",
  chave_pix: "Chave PIX",
  banco: "Banco",
  agencia: "Agência",
  conta: "Conta",
};

const OCULTOS = new Set(["id", "created_by", "created_at", "updated_at", "hash_integridade", "lote_id", "concedido_por", "obra_id", "user_id"]);

function formatarValor(campo: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (campo === "status" && typeof v === "string" && v in STATUS_PAGAMENTO) return STATUS_PAGAMENTO[v as StatusPagamento].rotulo;
  if (campo === "perfil" && typeof v === "string" && v in PERFIS) return PERFIS[v as Perfil];
  if ((campo === "valor" || campo === "valor_pago") && (typeof v === "number" || typeof v === "string")) return moeda(v);
  if ((campo === "vencimento" || campo === "pago_em") && typeof v === "string") return data(v);
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function Alteracoes({ antes, depois, nomes }: { antes: unknown; depois: unknown; nomes?: Record<string, string> }) {
  const a = (antes && typeof antes === "object" ? antes : {}) as Record<string, unknown>;
  const d = (depois && typeof depois === "object" ? depois : {}) as Record<string, unknown>;
  const campos = Object.keys({ ...a, ...d }).filter((k) => !OCULTOS.has(k) && ROTULOS_CAMPOS[k]);
  if (campos.length === 0 || Object.keys(a).length === 0) return null;
  const fmt = (k: string, v: unknown) => (typeof v === "string" && nomes?.[v]) || formatarValor(k, v);
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
      {campos.map((k) => (
        <li key={k}>
          <span className="font-medium">{ROTULOS_CAMPOS[k]}:</span> <span className="line-through decoration-slate-400">{fmt(k, a[k])}</span>{" "}
          → <span className="text-slate-900">{fmt(k, d[k])}</span>
        </li>
      ))}
    </ul>
  );
}

export function LinhaDoTempo({ eventos, nomes }: { eventos: EventoAuditoria[]; nomes?: Record<string, string> }) {
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {eventos.map((e) => {
        const a = ACOES[e.acao] ?? { rotulo: e.acao, cor: "bg-slate-400" };
        return (
          <li key={e.id} className="relative">
            <span className={cx("absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full ring-4 ring-white", a.cor)} />
            <div className="text-sm">
              <span className="font-medium text-slate-900">{a.rotulo}</span>
              {e.descricao && <span className="text-slate-700"> — {e.descricao}</span>}
            </div>
            {e.acao === "alterou" && <Alteracoes antes={e.dados_antes} depois={e.dados_depois} nomes={nomes} />}
            <div className="mt-0.5 text-xs text-slate-500">
              {e.user_nome ?? "Sistema"}
              {e.user_perfil && ` (${PERFIS[e.user_perfil]})`} · {dataHora(e.created_at)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
