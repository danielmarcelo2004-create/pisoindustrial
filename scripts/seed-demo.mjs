// Popula o banco LOCAL com dados de demonstração (usuários, obras, fornecedores
// e pagamentos em várias etapas). Uso: npm run seed:demo
// Senha de todos os usuários de demonstração: Demo-1234

import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { lerNFe } from "../src/lib/nfe.ts";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!/127\.0\.0\.1|localhost/.test(URL ?? "")) {
  console.error("O seed de demonstração só roda contra o Supabase local.");
  process.exit(1);
}
const SENHA = "Demo-1234";
const admin = createClient(URL, SECRET, { auth: { persistSession: false } });
const u = {};

async function usuario(chave, perfil, nome, telefone = null) {
  const email = `${chave}@demo.local`;
  let { data, error } = await admin.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message} (rode "npx supabase db reset" para recomeçar)`);
  await admin.from("profiles").insert({ id: data.user.id, nome, email, perfil, telefone, troca_senha_pendente: false });
  const client = createClient(URL, PUB, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password: SENHA });
  u[chave] = { id: data.user.id, client };
}
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
const hoje = new Date();
const dia = (n) => {
  const d = new Date(hoje);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function pdf(texto) {
  const corpo = `BT /F1 14 Tf 60 760 Td (${texto.replace(/[()\\]/g, "")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${corpo.length} >>\nstream\n${corpo}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let s = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(s);
}

async function anexar(chave, pagId, tipo, nome) {
  const pag = ok(await admin.from("pagamentos").select("id, obra_id, numero").eq("id", pagId).single());
  const bytes = pdf(`${nome} - pagamento ${pag.numero}`);
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`;
  ok(await u[chave].client.storage.from("documentos").upload(path, bytes, { contentType: "application/pdf" }));
  ok(
    await u[chave].client.rpc("registrar_documento", {
      p_pagamento_id: pag.id, p_tipo: tipo, p_nome_arquivo: `${nome}.pdf`, p_storage_path: path,
      p_mime_type: "application/pdf", p_tamanho: bytes.length, p_sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
}

async function pagamento(chave, obra, forn, descricao, valor, venc, forma = "boleto") {
  const id = ok(
    await u[chave].client.rpc("criar_pagamento", {
      p_obra_id: obra, p_fornecedor_id: forn.id, p_favorecido: "", p_descricao: descricao, p_valor: valor,
      p_vencimento: venc, p_forma_pagamento: forma, p_numero_documento: String(1000 + Math.floor(Math.random() * 9000)),
    }),
  );
  await anexar(chave, id, forma === "boleto" ? "boleto" : "outro", forma === "boleto" ? "boleto" : "pedido");
  await anexar(chave, id, "nota_fiscal", "nota-fiscal");
  return id;
}
// Quem aprova posiciona a própria assinatura no documento antes (regra de aprovação): registra a versão assinada.
const carimbar = async (chave, id) => {
  const pag = ok(await admin.from("pagamentos").select("id, obra_id, numero, versao").eq("id", id).single());
  const bytes = pdf(`assinado por ${chave} - pagamento ${pag.numero}`);
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`;
  ok(await u[chave].client.storage.from("documentos").upload(path, bytes, { contentType: "application/pdf" }));
  ok(
    await u[chave].client.rpc("registrar_documento", {
      p_pagamento_id: pag.id, p_tipo: "documento_assinado", p_nome_arquivo: `assinado-${chave}.pdf`, p_storage_path: path,
      p_mime_type: "application/pdf", p_tamanho: bytes.length, p_sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
};
const assinar = async (chave, id) => {
  await carimbar(chave, id);
  const { versao } = ok(await admin.from("pagamentos").select("versao").eq("id", id).single());
  ok(await u[chave].client.rpc("decidir_aprovacao", { p_itens: [{ id, versao }], p_decisao: "aprovado", p_ip: "127.0.0.1" }));
};

console.log("Criando usuários…");
await usuario("financeiro", "financeiro", "Fernanda Lima", "(71) 99999-0001");
await usuario("suprimentos", "suprimentos", "Sérgio Prado", "(71) 99999-0002");
await usuario("engenheiro", "engenheiro", "Eduardo Nunes", "(71) 99999-0003");
await usuario("administrador", "administrador", "Ana Ribeiro", "(71) 99999-0004");
await usuario("administrador2", "administrador", "Carlos Mendes");

console.log("Criando obras e fornecedores…");
const F = u.financeiro.client;
const obraA = ok(await F.from("obras").insert({ codigo: "OB-001", nome: "Galpão Logístico Camaçari", cliente: "LogBA S.A.", cidade: "Camaçari", uf: "BA", fluxo: "A", engenheiro_id: u.engenheiro.id, administrador_id: u.administrador.id }).select().single());
const obraB = ok(await F.from("obras").insert({ codigo: "OB-002", nome: "Piso Industrial Feira", cliente: "Atacadão Norte", cidade: "Feira de Santana", uf: "BA", fluxo: "B", administrador_id: u.administrador2.id }).select().single());
const obraC = ok(await F.from("obras").insert({ codigo: "OB-003", nome: "Ampliação CD Aracaju", cliente: "Distribuidora SE", cidade: "Aracaju", uf: "SE", fluxo: "C" }).select().single());
ok(await F.from("obra_acessos").insert([{ obra_id: obraA.id, user_id: u.suprimentos.id }, { obra_id: obraB.id, user_id: u.suprimentos.id }]));

const forns = ok(
  await F.from("fornecedores").insert([
    { nome: "Concreteira Baiana Ltda", cpf_cnpj: "12345678000190", cidade: "Salvador", uf: "BA", chave_pix: "financeiro@concreteirabaiana.com.br" },
    { nome: "Aço Forte Distribuidora", cpf_cnpj: "98765432000110", cidade: "Camaçari", uf: "BA", banco: "Banco do Brasil", agencia: "1234", conta: "56789-0" },
    { nome: "Locadora de Máquinas Nordeste", cpf_cnpj: "11222333000144", cidade: "Lauro de Freitas", uf: "BA" },
    { nome: "Endurecedor & Cia Químicos", cpf_cnpj: "55666777000188", cidade: "Aracaju", uf: "SE" },
  ]).select(),
);
const [concreto, aco, locadora, quimicos] = forns;

console.log("Criando pagamentos…");
const p1 = await pagamento("suprimentos", obraA.id, concreto, "Concreto usinado FCK 30 — 48 m³ (1ª etapa do piso)", 28450.0, dia(2));
const p2 = await pagamento("suprimentos", obraA.id, aco, "Tela soldada Q-196 — 120 painéis", 15980.4, dia(5));
const p3 = await pagamento("suprimentos", obraA.id, locadora, "Locação de acabadora de superfície (helicóptero) — novembro", 6200.0, dia(-1));
await assinar("engenheiro", p3);
const p4 = await pagamento("suprimentos", obraA.id, concreto, "Concreto usinado FCK 30 — 32 m³ (2ª etapa)", 18960.0, dia(0));
await assinar("engenheiro", p4);
await assinar("administrador", p4);
const p5 = await pagamento("suprimentos", obraB.id, quimicos, "Endurecedor de superfície — 40 sacos", 9340.0, dia(9));
const p6 = await pagamento("financeiro", obraC.id, locadora, "Locação de régua vibratória — 15 dias", 2150.0, dia(-3), "pix");
const p7 = await pagamento("financeiro", obraC.id, quimicos, "Selante PU para juntas — 60 cartuchos", 3720.0, dia(12), "transferencia");
const p8 = await pagamento("suprimentos", obraA.id, aco, "Barras de transferência 25 mm", 4410.0, dia(-10));
await assinar("engenheiro", p8);
await assinar("administrador", p8);
ok(await F.rpc("registrar_baixa", { p_id: p8, p_pago_em: dia(-11) }));
await anexar("financeiro", p8, "comprovante", "comprovante-pix");
const p9 = await pagamento("suprimentos", obraB.id, concreto, "Concreto FCK 35 — 20 m³", 12800.0, dia(4));
ok(await u.administrador2.client.rpc("decidir_aprovacao", { p_itens: [{ id: p9, versao: 1 }], p_decisao: "rejeitado", p_comentario: "Valor do m³ diverge da proposta aprovada (R$ 610,00)." }));

// ---------------------------------------------------------------------------
// Notas fiscais (XML) de meses anteriores para a Inteligência de Compras
// ---------------------------------------------------------------------------
console.log("Criando notas fiscais em XML (Inteligência de Compras)…");
const MATERIAIS = {
  concreto: { desc: "CONCRETO USINADO FCK 30 MPA BRITA 1", un: "M3", base: 590, ncm: "38245000" },
  tela: { desc: "TELA SOLDADA Q-196 2,45X6,00M", un: "PC", base: 132, ncm: "73142000" },
  endurecedor: { desc: "ENDURECEDOR DE SUPERFICIE MINERAL 25KG", un: "SC", base: 215, ncm: "38245000" },
  fibra: { desc: "FIBRA DE ACO PARA CONCRETO", un: "KG", base: 11.8, ncm: "73269090" },
  selante: { desc: "SELANTE PU PARA JUNTAS 400G", un: "UN", base: 56, ncm: "32141010" },
};
let seqNF = 7000;
function xmlNFe({ emitente, cnpj, uf, data: emissao, itens, frete = 0 }) {
  seqNF++;
  const chave = ("29" + emissao.slice(2, 4) + emissao.slice(5, 7) + cnpj + "55001" + String(seqNF).padStart(9, "0") + "1" + String(seqNF).padStart(8, "0")).slice(0, 43) + "7";
  const det = itens
    .map((it, i) => {
      const v = (it.q * it.vu).toFixed(2);
      return `<det nItem="${i + 1}"><prod><cProd>${it.cod}</cProd><xProd>${it.desc}</xProd><NCM>${it.ncm}</NCM><uCom>${it.un}</uCom><qCom>${it.q}</qCom><vUnCom>${it.vu}</vUnCom><vProd>${v}</vProd></prod></det>`;
    })
    .join("");
  const vProd = itens.reduce((s, it) => s + it.q * it.vu, 0);
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave}"><ide><serie>1</serie><nNF>${seqNF}</nNF><dhEmi>${emissao}T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>${emitente}</xNome><enderEmit><UF>${uf}</UF></enderEmit></emit>${det}<total><ICMSTot><vProd>${vProd.toFixed(2)}</vProd><vFrete>${frete.toFixed(2)}</vFrete><vNF>${(vProd + frete).toFixed(2)}</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`;
}
async function pagarCompleto(obra, forn, descricao, valor, venc) {
  const id = ok(
    await F.rpc("criar_pagamento", {
      p_obra_id: obra.id, p_fornecedor_id: forn.id, p_favorecido: "", p_descricao: descricao, p_valor: valor,
      p_vencimento: venc, p_forma_pagamento: "boleto", p_numero_documento: String(seqNF + 1),
    }),
  );
  return id;
}
async function concluir(obra, id, venc) {
  if (obra.fluxo === "A") await assinar("engenheiro", id);
  if (obra.fluxo === "A") await assinar("administrador", id);
  if (obra.fluxo === "B") await assinar("administrador2", id);
  ok(await F.rpc("registrar_baixa", { p_id: id, p_pago_em: venc }));
}
async function anexarXml(pagId, xml) {
  const pag = ok(await admin.from("pagamentos").select("id, obra_id").eq("id", pagId).single());
  const bytes = Buffer.from(xml);
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.xml`;
  ok(await F.storage.from("documentos").upload(path, bytes, { contentType: "application/xml" }));
  const docId = ok(
    await F.rpc("registrar_documento", {
      p_pagamento_id: pag.id, p_tipo: "nota_fiscal", p_nome_arquivo: `nfe-${seqNF}.xml`, p_storage_path: path,
      p_mime_type: "application/xml", p_tamanho: bytes.length, p_sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  const lida = lerNFe(xml);
  ok(await F.rpc("registrar_nf", { p_documento_id: docId, p_nota: lida.nota, p_itens: lida.itens, p_origem: "xml" }));
}
// Fator de preço por obra/fornecedor/mês (inflação leve + variação regional)
const compras = [
  // [mesesAtras, obra, fornecedor, [[material, qtd, fator]]]
  [5, obraA, concreto, [["concreto", 40, 1.0], ["fibra", 600, 1.0]]],
  [5, obraC, quimicos, [["endurecedor", 30, 1.02], ["selante", 80, 1.0]]],
  [4, obraA, aco, [["tela", 100, 1.0], ["fibra", 400, 1.03]]],
  [4, obraB, concreto, [["concreto", 25, 1.06]]],
  [3, obraC, quimicos, [["endurecedor", 20, 1.05], ["selante", 60, 1.04]]],
  [3, obraA, concreto, [["concreto", 55, 1.03]]],
  [2, obraB, aco, [["tela", 60, 1.08], ["fibra", 300, 1.05]]],
  [2, obraA, quimicos, [["endurecedor", 25, 1.04]]],
  [1, obraC, locadora, [["selante", 40, 1.38]]], // preço bem acima: gera alerta
  [1, obraA, concreto, [["concreto", 30, 1.05]]],
  [1, obraB, quimicos, [["endurecedor", 35, 1.31]]], // gera alerta
  [0, obraA, aco, [["tela", 80, 1.07], ["fibra", 500, 1.08]]],
];
for (const [mesesAtras, obra, forn, linhas] of compras) {
  const d = new Date(hoje.getFullYear(), hoje.getMonth() - mesesAtras, 8 + (seqNF % 12));
  if (d > hoje) d.setDate(hoje.getDate() - 1);
  const emissao = d.toISOString().slice(0, 10);
  const itens = linhas.map(([m, q, fator]) => ({
    cod: m.toUpperCase().slice(0, 6), desc: MATERIAIS[m].desc, un: MATERIAIS[m].un, ncm: MATERIAIS[m].ncm, q,
    vu: Math.round(MATERIAIS[m].base * fator * 100) / 100,
  }));
  const valor = Math.round(itens.reduce((s, i) => s + i.q * i.vu, 0) * 100) / 100;
  const id = await pagarCompleto(obra, forn, `Compra de materiais — ${itens.map((i) => i.desc.toLowerCase()).join(", ")}`.slice(0, 200), valor, emissao);
  await anexarXml(id, xmlNFe({ emitente: forn.nome.toUpperCase(), cnpj: forn.cpf_cnpj, uf: forn.uf, data: emissao, itens, frete: 150 }));
  await concluir(obra, id, emissao);
}

// ---------------------------------------------------------------------------
// Ordens de Pagamento do engenheiro
// ---------------------------------------------------------------------------
console.log("Criando solicitações de OP…");
const E = u.engenheiro.client;
const opRascunho = ok(
  await E.rpc("salvar_op", {
    p_id: null, p_obra_id: obraA.id, p_favorecido: "José Carlos Santos", p_cpf_cnpj: "52998224725",
    p_descricao: "Mão de obra avulsa — corte e selagem de juntas", p_vencimento: dia(6), p_forma_pagamento: "pix",
    p_dados_bancarios: "PIX CPF 529.982.247-25", p_observacoes: null,
    p_itens: [
      { descricao: "Corte de juntas com serra diamantada", unidade: "m", quantidade: 420, valor_unitario: 3.5 },
      { descricao: "Limpeza e selagem de juntas", unidade: "m", quantidade: 420, valor_unitario: 2.8 },
    ],
  }),
);
const opEnviada = ok(
  await E.rpc("salvar_op", {
    p_id: null, p_obra_id: obraA.id, p_favorecido: "Transportes Recôncavo ME", p_cpf_cnpj: "11444777000161",
    p_descricao: "Frete de equipamentos — semana 44", p_vencimento: dia(3), p_forma_pagamento: "transferencia",
    p_dados_bancarios: "Banco do Brasil · Ag 3456 · CC 12345-6", p_observacoes: "Frete ida e volta da acabadora.",
    p_itens: [{ descricao: "Frete caminhão munck", unidade: "viagem", quantidade: 2, valor_unitario: 950 }],
  }),
);
ok(await E.rpc("enviar_op", { p_id: opEnviada }));
ok(await u.engenheiro.client.from("ordens_pagamento").select("id").eq("id", opRascunho));

console.log(`\nPronto. ${[p1, p2, p3, p4, p5, p6, p7, p8, p9].length} pagamentos criados.`);
console.log(`Usuários (senha ${SENHA}): financeiro@demo.local, suprimentos@demo.local, engenheiro@demo.local, administrador@demo.local, administrador2@demo.local\n`);
