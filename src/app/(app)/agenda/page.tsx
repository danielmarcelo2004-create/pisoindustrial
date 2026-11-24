import type { Metadata } from "next";
import { AgendaCorpo } from "@/components/agenda-corpo";
import { Cabecalho } from "@/components/ui";

export const metadata: Metadata = { title: "Agenda de pagamentos" };

export default async function AgendaPage({ searchParams }: PageProps<"/agenda">) {
  const sp = await searchParams;
  return (
    <>
      <Cabecalho titulo="Agenda de pagamentos" subtitulo="Vencimentos do mês no calendário; clique num dia para ver só aquele dia." />
      <AgendaCorpo sp={sp} base="/agenda" />
    </>
  );
}
