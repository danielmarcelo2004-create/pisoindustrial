import "server-only";
import ExcelJS from "exceljs";

export type Coluna = { titulo: string; chave: string; largura?: number; formato?: "moeda" | "numero" | "data" | "texto" | "preco" };
export type Aba = { nome: string; colunas: Coluna[]; linhas: Record<string, unknown>[] };

/** Gera um .xlsx com abas, cabeçalho destacado, filtros e formatos brasileiros. */
export async function gerarExcel(abas: Aba[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Gestão Financeira de Obras";
  wb.created = new Date();
  for (const aba of abas) {
    const ws = wb.addWorksheet(aba.nome.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = aba.colunas.map((c) => ({ header: c.titulo, key: c.chave, width: c.largura ?? 16 }));
    for (const l of aba.linhas) {
      const linha: Record<string, unknown> = {};
      for (const c of aba.colunas) {
        const v = l[c.chave];
        if (c.formato === "data" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
          linha[c.chave] = new Date(v.slice(0, 10) + "T12:00:00Z");
        } else if ((c.formato === "moeda" || c.formato === "numero" || c.formato === "preco") && v !== null && v !== undefined && v !== "") {
          linha[c.chave] = Number(v);
        } else {
          linha[c.chave] = v ?? "";
        }
      }
      ws.addRow(linha);
    }
    aba.colunas.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.formato === "moeda") col.numFmt = '"R$" #,##0.00';
      if (c.formato === "preco") col.numFmt = '"R$" #,##0.00##';
      if (c.formato === "numero") col.numFmt = "#,##0.###";
      if (c.formato === "data") col.numFmt = "dd/mm/yyyy";
    });
    const cab = ws.getRow(1);
    cab.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cab.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5A" } };
    if (aba.linhas.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: aba.colunas.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function respostaExcel(buf: Buffer, nome: string) {
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
