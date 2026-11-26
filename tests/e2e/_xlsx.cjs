// Lê um .xlsx baixado pelos testes (exportações). Dados fictícios.
const ExcelJS = require('exceljs');

/** Devolve as abas com as linhas como listas de valores (datas viram "AAAA-MM-DD"; fórmulas viram o resultado). */
async function lerXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb.worksheets.map((ws) => {
    const linhas = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        let v = cell.value;
        if (v && typeof v === 'object' && 'result' in v) v = v.result;
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map((t) => t.text).join('');
        vals[c - 1] = v ?? '';
      });
      linhas.push({ n, vals, cells: row });
    });
    return { nome: ws.name, ws, linhas };
  });
}

/** Linhas de dados da tabela da aba: as que vêm depois da linha de cabeçalho cuja primeira célula é `primeiroTitulo`, sem a linha "Total". */
function dadosDaTabela(aba, primeiroTitulo) {
  const i = aba.linhas.findIndex((l) => String(l.vals[0]) === primeiroTitulo);
  if (i < 0) throw new Error(`cabeçalho "${primeiroTitulo}" não encontrado na aba ${aba.nome}`);
  return { cabecalho: aba.linhas[i].vals, linhas: aba.linhas.slice(i + 1).filter((l) => String(l.vals[0]) !== 'Total').map((l) => l.vals) };
}

const textoDoXlsx = (abas) => abas.map((a) => a.linhas.map((l) => l.vals.join(' ')).join('\n')).join('\n');

module.exports = { lerXlsx, dadosDaTabela, textoDoXlsx };
