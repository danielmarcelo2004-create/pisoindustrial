// Auxiliar de teste: o aprovador registra a própria versão assinada dos documentos pendentes
// (a regra de aprovação exige isso). Equivale a posicionar a assinatura na tela.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createHash, randomUUID } = require('crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
const URL_LOCAL = 'http://127.0.0.1:54321';
const PUB = env.match(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)$/m)[1].trim();

async function pdfBytes(texto) {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([595, 842]);
  pg.drawText(texto, { x: 50, y: 780, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

/** Carimba (registra versão assinada) em todos os pagamentos visíveis ao usuário no status informado. */
async function carimbarPendentes(email, senha, status) {
  const sb = createClient(URL_LOCAL, PUB, { auth: { persistSession: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error('login de carimbo: ' + error.message);
  const { data: pags } = await sb.from('pagamentos').select('id, obra_id, numero').eq('status', status);
  let n = 0;
  for (const p of pags || []) {
    const bytes = await pdfBytes(`assinado por ${email} - pagamento ${p.numero}`);
    const caminho = `${p.obra_id}/${p.id}/${randomUUID()}.pdf`;
    const up = await sb.storage.from('documentos').upload(caminho, bytes, { contentType: 'application/pdf' });
    if (up.error) throw new Error('upload carimbo: ' + up.error.message);
    const r = await sb.rpc('registrar_documento', {
      p_pagamento_id: p.id, p_tipo: 'documento_assinado', p_nome_arquivo: `assinado-${email.split('@')[0]}.pdf`,
      p_storage_path: caminho, p_mime_type: 'application/pdf', p_tamanho: bytes.length,
      p_sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (r.error) throw new Error('registrar carimbo: ' + r.error.message);
    n++;
  }
  await sb.auth.signOut();
  return n;
}
module.exports = { carimbarPendentes };
