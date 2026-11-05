// Teste: lembretes diários e envio de e-mail (Resend simulado).
// Pré-requisito: app em http://127.0.0.1:3000 com RESEND_API_URL=http://127.0.0.1:4556 e CRON_SECRET=segredo-teste.
const http = require('http');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const URL = 'http://127.0.0.1:54321';
const PUB = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const enviados = [];

(async () => {
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      enviados.push(JSON.parse(b || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"teste"}');
    });
  }).listen(4556);

  // 1. Pagamento que vence amanhã (horário de Brasília), ainda não pago
  const sb = createClient(URL, PUB, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email: 'financeiro@demo.local', password: 'Demo-1234' });
  const amanha = new Date(Date.now() - 3 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);
  const { data: obra } = await sb.from('obras').select('id').eq('fluxo', 'C').limit(1).single();
  const { data: id, error } = await sb.rpc('criar_pagamento', {
    p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: 'Fornecedor do aviso', p_descricao: 'Vence amanhã',
    p_valor: 123.45, p_vencimento: amanha, p_forma_pagamento: 'boleto',
  });
  if (error) throw new Error('criar: ' + error.message);
  console.log('✔ pagamento criado para vencer em', amanha);

  // 2. Lembretes diários (mesma rotina do agendamento das 07:30)
  const container = execSync('docker ps --format "{{.Names}}" | grep supabase_db_', { encoding: 'utf8' }).trim().split('\n')[0];
  execSync(`docker exec ${container} psql -U postgres -d postgres -tAc "select public.gerar_lembretes_diarios();"`, { stdio: 'pipe' });
  console.log('✔ lembretes gerados');

  // 3. Envio pela rota (mesma do agendamento)
  const resp = await fetch('http://127.0.0.1:3000/api/cron/email', { headers: { authorization: 'Bearer segredo-teste' } });
  const json = await resp.json();
  console.log('Rota:', JSON.stringify(json));
  await new Promise((r) => setTimeout(r, 300));
  const porDestino = enviados.map((e) => `${e.to[0]} — ${e.subject}`);
  console.log('E-mails enviados:\n  ' + porDestino.join('\n  '));

  const destinos = (email) => enviados.filter((e) => e.to[0] === email).map((e) => e.subject);
  const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('✔ ' + msg); };
  check(destinos('financeiro@demo.local').includes('Pagamento vence amanhã'), 'Financeiro recebe o aviso de pagamento que vence amanhã');
  check(destinos('suprimentos@demo.local').includes('Pagamento vence amanhã'), 'Suprimentos recebe o aviso de pagamento que vence amanhã');
  check(!destinos('financeiro@demo.local').includes('Documentos aguardando sua assinatura'), 'Financeiro não recebe aviso de assinatura');
  check(!destinos('suprimentos@demo.local').some((s) => /assinatura/.test(s)), 'Suprimentos não recebe aviso de assinatura');
  check(destinos('engenheiro@demo.local').some((s) => /assinatura/.test(s)), 'Engenheiro recebe aviso de assinatura');
  check(destinos('administrador@demo.local').some((s) => /assinatura/.test(s)), 'Administrador recebe aviso de assinatura');
  check(!destinos('engenheiro@demo.local').includes('Pagamento vence amanhã'), 'Engenheiro não recebe aviso de vencimento');

  // 4. Segunda execução não reenvia
  const antes = enviados.length;
  const r2 = await (await fetch('http://127.0.0.1:3000/api/cron/email', { headers: { authorization: 'Bearer segredo-teste' } })).json();
  check(enviados.length === antes && r2.processados === 0, 'segunda execução não reenvia nada');
  mock.close();
  console.log('✔ avisos por e-mail conferidos');
})().catch((e) => { console.error('✘ FALHOU:', e.message); process.exit(1); });
