// Gera uma nota fiscal de exemplo em PDF (texto), para testar a leitura por OCR.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
const linhas = [
  "DANFE - DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONICA",
  "CONCRETEIRA BAIANA LTDA",
  "CNPJ 12.345.678/0001-90 Ilha de Itaparica - BA",
  "Nº 4.567 Série 1",
  "DATA DA EMISSÃO 28/10/2026",
  "DADOS DO PRODUTO / SERVIÇO",
  "CÓD. DESCRIÇÃO DO PRODUTO NCM CST CFOP UN QUANT. V.UNIT. V.TOTAL",
  "CONC30 CONCRETO USINADO FCK 30 MPA 38245000 5101 M3 32,0000 592,50 18.960,00",
  "BOMB Serviço de bombeamento de concreto 00000000 5933 SV 1,0000 850,00 850,00",
  "ADIT Aditivo plastificante para concreto 38244000 5101 L 20,5000 14,80 303,40",
  "DESTINATÁRIO CNPJ 04.602.232/0001-70 CONSTRUTORA PARCERIA PROJ. E CONST. LTDA",
  "VALOR TOTAL DOS PRODUTOS 20.113,40",
  "VALOR DO FRETE 350,00",
  "VALOR TOTAL DA NOTA 20.463,40",
];
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const f = await pdf.embedFont(StandardFonts.Helvetica);
linhas.forEach((t, i) => page.drawText(t.normalize("NFC"), { x: 36, y: 800 - i * 22, size: 10, font: f }));
writeFileSync(process.argv[2], await pdf.save());
console.log("ok");
