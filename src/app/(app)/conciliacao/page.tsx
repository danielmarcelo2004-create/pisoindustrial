import { redirect } from "next/navigation";

/** Endereço antigo: a conciliação agora fica em "Contas bancárias". */
export default async function ConciliacaoAntiga({ searchParams }: PageProps<"/conciliacao">) {
  const sp = await searchParams;
  const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"));
  redirect(`/contas-bancarias${q.size ? `?${q}` : ""}`);
}
