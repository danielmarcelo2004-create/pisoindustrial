import type { Database } from "@/lib/database.types";

type Enums = Database["public"]["Enums"];
export type Perfil = Enums["perfil_usuario"];
export type StatusPagamento = Enums["status_pagamento"];
export type Fluxo = Enums["fluxo_aprovacao"];
export type TipoDocumento = Enums["tipo_documento"];
export type FormaPagamento = Enums["forma_pagamento"];
export type StatusObra = Enums["status_obra"];

export const PERFIS: Record<Perfil, string> = {
  administrador_master: "Administrador master",
  financeiro: "Financeiro",
  suprimentos: "Suprimentos",
  engenheiro: "Engenheiro",
  administrador: "Administrador da obra",
};

export const STATUS_PAGAMENTO: Record<StatusPagamento, { rotulo: string; cor: Cor }> = {
  aguardando_engenheiro: { rotulo: "Aguardando engenheiro", cor: "amarelo" },
  aguardando_administrador: { rotulo: "Aguardando administrador", cor: "amarelo" },
  aguardando_pagamento: { rotulo: "Liberado p/ pagamento", cor: "azul" },
  pago: { rotulo: "Pago", cor: "verde" },
  rejeitado: { rotulo: "Rejeitado", cor: "vermelho" },
  cancelado: { rotulo: "Cancelado", cor: "cinza" },
};

export const STATUS_EM_ABERTO: StatusPagamento[] = [
  "aguardando_engenheiro",
  "aguardando_administrador",
  "aguardando_pagamento",
];

export const FLUXOS: Record<Fluxo, { rotulo: string; descricao: string }> = {
  A: { rotulo: "Fluxo A — Engenheiro e administrador", descricao: "O engenheiro confere e assina; depois o administrador confere e assina." },
  B: { rotulo: "Fluxo B — Somente administrador", descricao: "O documento segue direto para o administrador responsável." },
  C: { rotulo: "Fluxo C — Sem assinaturas", descricao: "O documento segue direto ao Financeiro, sem etapa de engenheiro ou administrador." },
};

export const TIPOS_DOCUMENTO: Record<TipoDocumento, string> = {
  boleto: "Boleto",
  nota_fiscal: "Nota fiscal",
  ordem_pagamento: "Ordem de pagamento",
  comprovante: "Comprovante de pagamento",
  outro: "Outro documento",
};

export const FORMAS_PAGAMENTO: Record<FormaPagamento, string> = {
  boleto: "Boleto",
  pix: "PIX",
  transferencia: "Transferência",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  outro: "Outro",
};

export const STATUS_OBRA: Record<StatusObra, string> = {
  ativa: "Ativa",
  suspensa: "Suspensa",
  concluida: "Concluída",
};

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE",
  "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

export type Cor = "amarelo" | "azul" | "verde" | "vermelho" | "cinza" | "roxo";

export type StatusOP = Enums["status_op"];
export const STATUS_OP: Record<StatusOP, { rotulo: string; cor: Cor }> = {
  em_elaboracao: { rotulo: "Em elaboração", cor: "cinza" },
  enviada: { rotulo: "Enviada", cor: "azul" },
  em_analise: { rotulo: "Em análise", cor: "amarelo" },
  aprovada: { rotulo: "Aprovada", cor: "verde" },
  rejeitada: { rotulo: "Rejeitada", cor: "vermelho" },
  paga: { rotulo: "Paga", cor: "verde" },
  cancelada: { rotulo: "Cancelada", cor: "cinza" },
};
