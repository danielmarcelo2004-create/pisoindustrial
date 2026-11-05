import type { Metadata } from "next";
import Link from "next/link";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Aviso, Cabecalho, Cartao, Indicador, LinkBotao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { pagamentosEmAberto, SELECAO_LISTA, somar } from "@/lib/consultas/pagamentos";
import { hojeISO, moeda, somarDias } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Painel" };

export default async function PainelPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const supabase = await createClient();
  const hoje = hojeISO();
  const em7 = somarDias(hoje, 7);
  const inicioMes = hoje.slice(0, 8) + "01";

  const [abertos, pendRes, pagosRes] = await Promise.all([
    pagamentosEmAberto(),
    supabase.rpc("minhas_pendencias").select(SELECAO_LISTA).order("vencimento").limit(10),
    supabase.from("pagamentos").select("valor_pago, valor").eq("status", "pago").gte("pago_em", inicioMes).lte("pago_em", hoje),
  ]);

  const vencidos = abertos.filter((p) => p.vencimento < hoje);
  const deHoje = abertos.filter((p) => p.vencimento === hoje);
  const proximos = abertos.filter((p) => p.vencimento > hoje && p.vencimento <= em7);
  const emAprovacao = abertos.filter((p) => p.status === "aguardando_engenheiro" || p.status === "aguardando_administrador");
  const liberados = abertos.filter((p) => p.status === "aguardando_pagamento");
  const pagosMes = (pagosRes.data ?? []).reduce((s, p) => s + Number(p.valor_pago ?? p.valor), 0);
  const pendencias = pendRes.data ?? [];

  const podeCadastrar = u.perfil === "financeiro" || u.perfil === "suprimentos";
  const assinante = u.perfil === "engenheiro" || u.perfil === "administrador" || u.perfil === "administrador_master";

  return (
    <>
      <Cabecalho
        titulo={`Olá, ${u.nome.split(" ")[0]}`}
        subtitulo={
          u.perfil === "financeiro"
            ? "Visão geral de todas as obras"
            : u.perfil === "suprimentos"
              ? "Visão geral das obras"
              : "Visão das obras sob sua responsabilidade"
        }
        acoes={podeCadastrar && <LinkBotao href="/pagamentos/novo">+ Novo pagamento</LinkBotao>}
      />

      {sp["senha"] === "alterada" && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Senha definida com sucesso.</Aviso>
        </div>
      )}
      {sp["sem-permissao"] && (
        <div className="mb-4">
          <Aviso tipo="alerta">Você não tem permissão para acessar aquela página.</Aviso>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Indicador rotulo="Vencidos" valor={vencidos.length} detalhe={moeda(somar(vencidos))} cor="vermelho" href="/agenda#vencidos" />
        <Indicador rotulo="Vencem hoje" valor={deHoje.length} detalhe={moeda(somar(deHoje))} cor="amarelo" href="/agenda#hoje" />
        <Indicador rotulo="Próximos 7 dias" valor={proximos.length} detalhe={moeda(somar(proximos))} cor="azul" href="/agenda#proximos" />
        <Indicador
          rotulo="Em aprovação"
          valor={emAprovacao.length}
          detalhe={moeda(somar(emAprovacao))}
          cor="amarelo"
          href="/pagamentos?status=em_aprovacao"
        />
        <Indicador
          rotulo="A pagar"
          valor={liberados.length}
          detalhe={moeda(somar(liberados))}
          cor="marca"
          href="/pagamentos?status=aguardando_pagamento"
        />
        <Indicador rotulo="Pagos no mês" valor={moeda(pagosMes)} cor="verde" href="/pagamentos?status=pago" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Cartao
          titulo={assinante ? "Aguardando sua assinatura" : (u.perfil === "financeiro" || u.perfil === "administrador_master") ? "Liberados para pagamento" : "Em aprovação"}
          acoes={
            assinante ? (
              <LinkBotao href="/aprovacoes" variante="secundario" tamanho="sm">
                Assinar em lote
              </LinkBotao>
            ) : undefined
          }
          semPadding
        >
          <TabelaPagamentos
            itens={assinante || u.perfil === "financeiro" || u.perfil === "administrador_master" ? pendencias : emAprovacao.slice(0, 10)}
            vazio="Nenhuma pendência no momento."
            compacto
          />
        </Cartao>

        <Cartao
          titulo="Vencidos e próximos vencimentos"
          acoes={
            <Link href="/agenda" className="text-sm text-marca-600 hover:underline">
              Ver agenda →
            </Link>
          }
          semPadding
        >
          <TabelaPagamentos itens={[...vencidos, ...deHoje, ...proximos].slice(0, 10)} vazio="Nada vencido nos próximos 7 dias." compacto />
        </Cartao>
      </div>
    </>
  );
}
