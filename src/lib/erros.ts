type ErroSupabase = { message?: string; code?: string; details?: string | null } | null | undefined;

/** Converte erros do banco em mensagens claras para o usuário. */
export function mensagemErro(e: ErroSupabase, padrao = "Não foi possível concluir a operação."): string {
  if (!e) return padrao;
  const msg = e.message ?? "";
  if (/row-level security|permission denied/i.test(msg)) return "Você não tem permissão para esta operação.";
  if (e.code === "23505") return "Já existe um cadastro com esses dados (código, CPF/CNPJ ou e-mail).";
  if (/obras_fluxo_responsaveis/.test(msg))
    return "O fluxo escolhido exige responsáveis: Fluxo A precisa de engenheiro e administrador; Fluxo B precisa de administrador.";
  if (e.code === "23514") return "Dados inválidos. Confira os campos preenchidos.";
  if (e.code === "22P02" || e.code === "22007" || e.code === "22008") return "Formato de dado inválido.";
  if (/fetch failed|network/i.test(msg)) return "Falha de comunicação com o servidor. Tente novamente.";
  return msg || padrao;
}

export type Estado = { erro?: string; ok?: string; dados?: Record<string, string> } | null;
