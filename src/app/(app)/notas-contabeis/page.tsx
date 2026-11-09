import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Cartao, Selo, Vazio } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { listarNotasContabeis, type SituacaoNota } from "@/lib/consultas/notas-contabeis";
import { data, cpfCnpj, moeda } from "@/lib/formato";
import { ROTULO_CATEGORIA, type CategoriaNota } from "@/lib/notas-contabeis";
import { marcarNotaEnviada } from "./actions";

export const metadata: Metadata = { title: "Notas fiscais para enviar para contabilidade" };

const SITUACOES: { valor: SituacaoNota; rotulo: string }[] = [
  { valor: "pendentes", rotulo: "A enviar" },
  { valor: "enviadas", rotulo: "Enviadas" },
  { valor: "todas", rotulo: "Todas" },
];
const COR: Record<CategoriaNota, "azul" | "roxo" | "verde" | "amarelo"> = {
  tomado_pj_retencao: "azul",
  tomado_pf: "roxo",
  mei_servicos_especificos: "verde",
  medicao_emitida: "amarelo",
};
const RET: { chave: "inss" | "irrf" | "csrf" | "iss"; rotulo: string }[] = [
  { chave: "inss", rotulo: "INSS" },
  { chave: "irrf", rotulo: "IRRF" },
  { chave: "csrf", rotulo: "CSRF" },
  { chave: "iss", rotulo: "ISS" },
];

export default async function NotasContabeisPage({ searchParams }: PageProps<"/notas-contabeis">) {
  const u = await exigirPerfil("financeiro", "suprimentos");
  const sp = await searchParams;
  const situacao: SituacaoNota = sp.situacao === "enviadas" || sp.situacao === "todas" ? sp.situacao : "pendentes";
  const notas = await listarNotasContabeis(situacao);
  const fin = u.perfil === "financeiro";
  const aEnviar = (await listarNotasContabeis("pendentes")).length;
  const qs = (s: SituacaoNota) => `/notas-contabeis?situacao=${s}`;

  return (
    <>
      <Cabecalho
        titulo="Notas Fiscais para enviar para contabilidade"
        subtitulo="Notas identificadas ao serem anexadas a um pagamento: serviço tomado de PJ com retenção, serviço tomado de PF e MEI com serviços específicos."
        acoes={
          <a href={`/notas-contabeis/exportar?situacao=${situacao}`} className="text-sm font-medium text-marca-700 hover:underline">
            Exportar Excel
          </a>
        }
      />
      {sp.aviso && (
        <div className="mb-4">
          <Aviso tipo="sucesso">
            {sp.aviso === "enviada" ? "Nota marcada como enviada à contabilidade." : "Nota reaberta para envio."}
          </Aviso>
        </div>
      )}
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Situação">
        {SITUACOES.map((s) => (
          <Link
            key={s.valor}
            href={qs(s.valor)}
            className={
              s.valor === situacao
                ? "rounded-md bg-marca-700 px-3 py-1.5 font-medium text-white"
                : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
            }
          >
            {s.rotulo}
            {s.valor === "pendentes" && aEnviar > 0 ? ` (${aEnviar})` : ""}
          </Link>
        ))}
      </nav>

      <Cartao titulo={`Notas (${notas.length})`} semPadding>
        {!notas.length ? (
          <Vazio>{situacao === "pendentes" ? "Nenhuma nota aguardando envio." : "Nenhuma nota nesta situação."}</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Emissão</th>
                  <th>Categoria</th>
                  <th>Prestador</th>
                  <th>Nº</th>
                  <th className="text-right">Valor</th>
                  <th>Retenções</th>
                  <th>Obra · pagamento</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {notas.map((n) => {
                  const retidos = RET.filter((r) => (n.retencoes?.[r.chave] ?? 0) > 0);
                  return (
                    <tr key={n.id}>
                      <td className="whitespace-nowrap tabular-nums">{n.data_emissao ? data(n.data_emissao) : "—"}</td>
                      <td><Selo cor={COR[n.categoria]}>{ROTULO_CATEGORIA[n.categoria]}</Selo></td>
                      <td className="min-w-48">
                        <div className="font-medium">{n.prestador_nome ?? "—"}</div>
                        <div className="text-xs text-slate-500 tabular-nums">{cpfCnpj(n.prestador_documento)}</div>
                      </td>
                      <td className="whitespace-nowrap">{n.numero ?? "—"}</td>
                      <td className="text-right tabular-nums">{n.valor === null ? "—" : moeda(n.valor)}</td>
                      <td className="text-xs">
                        {retidos.length ? retidos.map((r) => `${r.rotulo} ${moeda(n.retencoes[r.chave] ?? 0)}`).join(" · ") : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="min-w-44 text-xs">
                        <div>{n.obra?.nome}</div>
                        {n.pagamento && (
                          <Link href={`/pagamentos/${n.pagamento.id}`} className="text-marca-700 hover:underline">
                            {n.pagamento.descricao}
                          </Link>
                        )}
                        {n.documento && (
                          <div>
                            <a href={`/documentos/${n.documento.id}`} target="_blank" rel="noreferrer" className="text-marca-700 hover:underline">
                              {n.documento.nome_arquivo}
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="min-w-40">
                        {n.enviada_em ? (
                          <div className="space-y-1">
                            <Selo cor="verde">Enviada em {data(n.enviada_em)}</Selo>
                            {fin && <FormAcao action={marcarNotaEnviada.bind(null, n.id, false)} enviar="Reabrir" variante="fantasma" className="" />}
                          </div>
                        ) : fin ? (
                          <FormAcao action={marcarNotaEnviada.bind(null, n.id, true)} enviar="Marcar como enviada" variante="secundario" className="" />
                        ) : (
                          <Selo cor="amarelo">A enviar</Selo>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </>
  );
}
