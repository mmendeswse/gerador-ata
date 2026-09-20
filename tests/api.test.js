import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { loadConfig } from '../backend/config.js';
import { createGeminiProvider } from '../backend/providers/gemini.js';
import { resetMockState } from '../backend/providers/mock.js';
import { handleApiRequest } from '../backend/router.js';

const BASE = 'https://backend.exemplo/api';
const MOCK_ENV = { AI_PROVIDER: 'mock', MOCK_DELAY_MS: '0' };

function post(path, body, env = MOCK_ENV, headers = {}) {
  return handleApiRequest(
    new Request(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function transcribe(env = MOCK_ENV, meta = { chunkIndex: 0, totalChunks: 1, startSeconds: 0, endSeconds: 900 }) {
  const form = new FormData();
  form.set('audio', new Blob([new Uint8Array(2048)], { type: 'audio/mpeg' }), 'trecho-001.mp3');
  form.set('meta', JSON.stringify(meta));
  const response = await handleApiRequest(new Request(`${BASE}/transcribe`, { method: 'POST', body: form }), env);
  return { response, data: await response.json() };
}

beforeEach(() => resetMockState());

test('health não expõe segredos e informa a configuração', async () => {
  const response = await handleApiRequest(new Request(`${BASE}/health`), {
    GEMINI_API_KEY: 'chave-super-secreta',
    ACCESS_PASSWORD: 'senha-forte',
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes('chave-super-secreta'));
  assert.ok(!text.includes('senha-forte'));
  const data = JSON.parse(text);
  assert.equal(data.configured, true);
  assert.equal(data.requiresPassword, true);
  assert.equal(data.providerLabel, 'Google Gemini');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('senha de acesso: ausente, incorreta e correta', async () => {
  const env = { ...MOCK_ENV, ACCESS_PASSWORD: 'Sessão#2026' };
  const missing = await post('task', { task: 'analyze', payload: {} }, env);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'AUTH_REQUIRED');

  const wrong = await post('task', { task: 'analyze', payload: {} }, env, { Authorization: 'Bearer errada' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'AUTH_INVALID');

  const okHeader = { Authorization: `Bearer ${encodeURIComponent('Sessão#2026')}` };
  const health = await handleApiRequest(new Request(`${BASE}/health`, { headers: okHeader }), env);
  assert.equal((await health.json()).authenticated, true);

  const passed = await post('task', { task: 'analyze', payload: {} }, env, okHeader);
  assert.equal(passed.status, 400, 'autenticado: agora o erro é de validação do corpo');
});

test('CORS: somente origens autorizadas recebem o cabeçalho', async () => {
  const env = { ...MOCK_ENV, ALLOWED_ORIGINS: 'https://usuario.github.io/repo/, http://localhost:3000' };
  const allowed = await handleApiRequest(
    new Request(`${BASE}/health`, { headers: { Origin: 'https://usuario.github.io' } }),
    env,
  );
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://usuario.github.io');

  const denied = await handleApiRequest(
    new Request(`${BASE}/health`, { headers: { Origin: 'https://site-malicioso.example' } }),
    env,
  );
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);

  const preflight = await handleApiRequest(
    new Request(`${BASE}/task`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } }),
    env,
  );
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('validações de entrada: rota, método, JSON e tamanho do áudio', async () => {
  assert.equal((await handleApiRequest(new Request(`${BASE}/inexistente`), MOCK_ENV)).status, 404);
  assert.equal((await handleApiRequest(new Request(`${BASE}/task`), MOCK_ENV)).status, 405);
  assert.equal((await post('task', { task: 'apagar_tudo' })).status, 400);

  const bad = await handleApiRequest(
    new Request(`${BASE}/task`, { method: 'POST', body: '{nao é json', headers: { 'Content-Type': 'application/json' } }),
    MOCK_ENV,
  );
  assert.equal(bad.status, 400);

  const form = new FormData();
  form.set('audio', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'grande.mp3');
  const big = await handleApiRequest(
    new Request(`${BASE}/transcribe`, { method: 'POST', body: form }),
    { ...MOCK_ENV, MAX_AUDIO_MB: '1' },
  );
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('servidor sem chave de API responde com erro claro', async () => {
  const { response, data } = await transcribe({});
  assert.equal(response.status, 500);
  assert.equal(data.error.code, 'SERVER_NOT_CONFIGURED');
});

test('fluxo completo com o provedor simulado, incluindo os controles de fidelidade', async () => {
  const meetingInfo = { number: '92ª', type: 'Reunião Ordinária', body: 'Comissão de Prerrogativas', date: '11/12/2025', location: 'Sala 8', president: '', participants: 'Helena — Secretária' };

  // 1) transcrição em dois trechos
  const part1 = await transcribe(MOCK_ENV, { chunkIndex: 0, totalChunks: 2, startSeconds: 0, endSeconds: 600, meetingInfo });
  const part2 = await transcribe(MOCK_ENV, { chunkIndex: 1, totalChunks: 2, startSeconds: 600, endSeconds: 1200, meetingInfo });
  assert.equal(part1.data.ok, true);
  assert.equal(part1.data.needsSplit, false);
  const segments = [...part1.data.segments.map((s) => ({ ...s })), ...part2.data.segments.map((s) => ({ ...s, start: s.start + 600 }))]
    .map((s, i) => ({ id: i + 1, ...s }));
  assert.equal(segments.length, 18);

  // 2) participantes
  const participantsRes = await (await post('task', { task: 'participants', payload: { segments, meetingInfo, roster: part1.data.speakers } })).json();
  assert.equal(participantsRes.participants.length, 5);
  const unknown = participantsRes.participants.find((p) => p.label === 'Falante 5');
  assert.equal(unknown.name, '', 'identidade nunca é inventada');
  const { participants, mentioned } = participantsRes;

  // 3) análise
  const { analysis } = await (await post('task', { task: 'analyze', payload: { segments, participants, meetingInfo } })).json();
  assert.equal(analysis.houve_encerramento_formal, true);

  // 4) deliberações: a segunda "deliberação" do simulador tem citação inexistente e deve ser rebaixada
  const delib = await (await post('task', { task: 'deliberations', payload: { segments, participants, meetingInfo, analysis } })).json();
  assert.equal(delib.summary.deliberations, 1);
  assert.equal(delib.summary.downgraded, 1);
  const { items } = delib;

  // 5) ata
  const ata = await (await post('task', { task: 'ata', payload: { segments, participants, mentioned, meetingInfo, analysis, items } })).json();
  assert.match(ata.text, /^ATA DA 92ª REUNIÃO ORDINÁRIA DA COMISSÃO DE PRERROGATIVAS$/m);
  assert.match(ata.text, /^Data: 11 de dezembro de 2025$/m);
  assert.match(ata.text, /\[Presidente não nomeado\]/);

  // 6) momento aberto
  const located = await (await post('task', { task: 'momento_identify', payload: { segments, participants, meetingInfo } })).json();
  assert.deepEqual([located.found, located.from, located.to], [true, 2, 7]);
  const momento = await (await post('task', { task: 'momento', payload: { segments, participants, meetingInfo, analysis, scope: { mode: 'trecho', from: located.from, to: located.to } } })).json();
  assert.match(momento.text, /^MOMENTO ABERTO – 92ª REUNIÃO ORDINÁRIA DA COMISSÃO DE PRERROGATIVAS 11\/12\/2025$/m);
  assert.deepEqual(momento.formatProblems, []);

  // 7) revisão: remove o trecho sem respaldo e gera os alertas determinísticos
  const review = await (await post('task', { task: 'review', payload: { segments, participants, mentioned, meetingInfo, items, documents: { ata: ata.text, momento: momento.text } } })).json();
  assert.equal(review.aiReviewed, true);
  assert.equal(review.ata.applied.length, 1);
  assert.ok(!review.ata.text.includes('com louvor'));
  assert.ok(review.ata.alerts.some((a) => a.code === 'DELIBERACAO_NAO_CONFIRMADA'));
  assert.ok(!review.ata.alerts.some((a) => a.code === 'NUMEROS_NAO_LOCALIZADOS'), JSON.stringify(review.ata.alerts));
  assert.ok(!review.momento.alerts.some((a) => a.code === 'FORMATO_MOMENTO_ABERTO'));

  // revisão somente determinística (usada quando a IA de revisão falha)
  const offline = await (await post('task', { task: 'review', payload: { segments, participants, meetingInfo, items, aiReview: false, documents: { ata: ata.text } } })).json();
  assert.equal(offline.aiReviewed, false);
  assert.ok(offline.ata.text.includes('com louvor'));
});

test('Momento Aberto em formato de roteiro é refeito automaticamente', async () => {
  const env = { ...MOCK_ENV, MOCK_SCENARIO: 'script_format' };
  const { data } = await transcribe(env);
  const segments = data.segments.map((s, i) => ({ id: i + 1, ...s }));
  const momento = await (await post('task', { task: 'momento', payload: { segments, participants: [], meetingInfo: {}, scope: { mode: 'reuniao_inteira' } } }, env)).json();
  assert.equal(momento.retried, true);
  assert.deepEqual(momento.formatProblems, []);
  assert.ok(!momento.text.includes('[Presidente]'));
});

test('saída truncada da transcrição pede divisão do trecho; limite de uso informa a espera', async () => {
  const truncated = await transcribe({ ...MOCK_ENV, MOCK_SCENARIO: 'truncate_first' });
  assert.equal(truncated.data.needsSplit, true);
  assert.equal(truncated.data.splitReason, 'saida_truncada');

  resetMockState();
  const limited = await transcribe({ ...MOCK_ENV, MOCK_SCENARIO: 'rate_limit_once' });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.data.error.code, 'AI_RATE_LIMIT');
  assert.equal(limited.data.error.retryAfterSeconds, 2);
  assert.equal(limited.response.headers.get('Retry-After'), '2');
});

// ---------------------------------------------------------------------------
// Provedor Gemini com a rede simulada
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function geminiReply(text, finishReason = 'STOP') {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pensando', thought: true }, { text }] }, finishReason }], usageMetadata: { totalTokenCount: 10 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function geminiError(status, message, details = []) {
  return new Response(JSON.stringify({ error: { code: status, message, details } }), { status });
}

test('Gemini: chave só no cabeçalho, áudio embutido, store=false e partes de raciocínio ignoradas', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return geminiReply('{"segmentos":[],"falantes":[],"qualidade_audio":"sem_fala"}');
  };
  const provider = createGeminiProvider(loadConfig({ GEMINI_API_KEY: 'CHAVE123', GEMINI_MODEL: 'gemini-teste', GEMINI_FALLBACK_MODELS: '' }));
  const result = await provider.transcribe({ audio: new Uint8Array([1, 2, 3, 4]).buffer, system: 's', user: 'u', schema: { type: 'OBJECT' } });

  assert.equal(result.text.includes('pensando'), false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/models/gemini-teste:generateContent'));
  assert.ok(!calls[0].url.includes('CHAVE123'), 'a chave nunca vai na URL');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'CHAVE123');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.store, false);
  assert.equal(body.contents[0].parts[0].inlineData.data, 'AQIDBA==');
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'audio/mp3');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, undefined, 'temperatura padrão do modelo');
});

test('Gemini: modelo inexistente cai para o próximo; campo recusado é removido e a chamada repetida', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const model = String(url).match(/models\/([^:]+):/)[1];
    const body = JSON.parse(init.body);
    seen.push({ model, hasStore: 'store' in body, hasSchema: Boolean(body.generationConfig.responseSchema) });
    if (model === 'modelo-aposentado') return geminiError(404, 'models/modelo-aposentado is not found');
    if ('store' in body) return geminiError(400, 'Invalid JSON payload received. Unknown name "store"');
    return geminiReply('{"ok":true}');
  };
  const provider = createGeminiProvider(loadConfig({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'modelo-aposentado', GEMINI_FALLBACK_MODELS: 'modelo-novo' }));
  const result = await provider.generateJson({ system: 's', user: 'u', schema: { type: 'OBJECT' } });
  assert.equal(result.model, 'modelo-novo');
  assert.deepEqual(seen.map((s) => s.model), ['modelo-aposentado', 'modelo-novo', 'modelo-novo']);
  assert.equal(seen[2].hasStore, false);
  assert.equal(seen[2].hasSchema, true);
});

test('Gemini: mapeamento de erros (limite, cota diária, chave inválida, bloqueio, nenhum modelo)', async () => {
  const config = loadConfig({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm', GEMINI_FALLBACK_MODELS: '' });
  const provider = createGeminiProvider(config);
  const expectCode = async (reply, code) => {
    globalThis.fetch = async () => reply();
    await assert.rejects(provider.generateText({ system: 's', user: 'u' }), (error) => {
      assert.equal(error.code, code);
      return true;
    });
  };

  await expectCode(() => geminiError(429, 'Resource exhausted', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }]), 'AI_RATE_LIMIT');
  await expectCode(() => geminiError(429, 'Quota exceeded', [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]), 'AI_QUOTA_EXHAUSTED');
  await expectCode(() => geminiError(400, 'API key not valid. Please pass a valid API key.'), 'AI_AUTH');
  await expectCode(() => geminiError(404, 'not found'), 'AI_MODEL_NOT_FOUND');
  await expectCode(() => new Response(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), { status: 200 }), 'AI_BLOCKED');

  globalThis.fetch = async () => geminiError(429, 'x', [{ retryDelay: '37s' }]);
  await assert.rejects(provider.generateText({ system: 's', user: 'u' }), (error) => error.extra.retryAfterSeconds === 37);
});
