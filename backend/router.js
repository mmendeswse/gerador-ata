/**
 * Roteador da API — único ponto de entrada do backend.
 *
 * Usa apenas APIs Web padrão (Request/Response/FormData), por isso o mesmo
 * código atende:
 *   • Vercel Functions     → api/*.js
 *   • Cloudflare Workers   → worker.js
 *   • Node.js (local/VPS)  → local-server.js
 *
 * Rotas:
 *   GET  /api/health      situação do servidor (sem segredos)
 *   POST /api/transcribe  multipart: "audio" (arquivo) + "meta" (JSON)
 *   POST /api/task        JSON: { task, payload }
 *
 * PRIVACIDADE: nada é gravado em disco; os logs contêm somente metadados
 * (rota, tarefa, status, duração e tamanhos) — nunca áudio, transcrição ou texto.
 */

import { loadConfig, publicInfo } from './config.js';
import { AppError, Errors } from './errors.js';
import {
  assertContentLength,
  corsHeaders,
  errorResponse,
  jsonResponse,
  preflightResponse,
  readJson,
  requireAuth,
} from './http.js';
import { createProvider } from './providers/index.js';
import { runTask, runTranscription, TASK_NAMES } from './tasks.js';

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function routeFromPath(pathname) {
  const match = pathname.replace(/\/+$/, '').match(/\/api\/([a-z_-]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function logLine(fields) {
  // Somente metadados. NUNCA registrar conteúdo da reunião.
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

async function handleTranscribe(request, config, provider) {
  assertContentLength(request, config.maxAudioBytes + MULTIPART_OVERHEAD_BYTES);

  let form;
  try {
    form = await request.formData();
  } catch {
    throw Errors.badRequest('Envie o áudio como multipart/form-data.');
  }

  const file = form.get('audio');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw Errors.badRequest('Campo "audio" ausente.');
  }
  if (file.size === 0) throw Errors.badRequest('O trecho de áudio está vazio.');
  if (file.size > config.maxAudioBytes) {
    throw Errors.payloadTooLarge((config.maxAudioBytes / 1024 / 1024).toFixed(1));
  }

  let meta = {};
  const rawMeta = form.get('meta');
  if (typeof rawMeta === 'string' && rawMeta) {
    try {
      meta = JSON.parse(rawMeta);
    } catch {
      throw Errors.badRequest('Campo "meta" não é um JSON válido.');
    }
  }

  const audio = await file.arrayBuffer();
  const result = await runTranscription({ provider, audio, meta });
  return { result, details: { audioBytes: file.size, segments: result.segments.length } };
}

async function handleTask(request, config, provider, startedAt) {
  const body = await readJson(request, config.maxJsonBytes);
  const task = typeof body.task === 'string' ? body.task : '';
  if (!TASK_NAMES.includes(task)) throw Errors.badRequest('Tarefa desconhecida.');
  const result = await runTask({ provider, config, task, payload: body.payload ?? {}, startedAt });
  return { result, details: { task } };
}

/**
 * @param {Request} request
 * @param {Record<string, string|undefined>} env  variáveis de ambiente
 * @param {{ route?: string }} [options]          rota fixa (usada pelos adaptadores da Vercel)
 * @returns {Promise<Response>}
 */
export async function handleApiRequest(request, env, options = {}) {
  const startedAt = Date.now();
  const config = loadConfig(env);
  const cors = corsHeaders(request, config);
  const route = options.route || routeFromPath(new URL(request.url).pathname);

  if (request.method === 'OPTIONS') return preflightResponse(request, config);

  let details = {};
  try {
    if (route === 'health') {
      if (request.method !== 'GET') throw Errors.methodNotAllowed();
      const info = publicInfo(config);
      // Permite ao frontend validar a senha sem gastar nenhuma chamada de IA.
      if (request.headers.get('Authorization')) {
        await requireAuth(request, config);
        info.authenticated = true;
      }
      return jsonResponse(info, 200, cors);
    }

    if (route !== 'transcribe' && route !== 'task') throw Errors.notFound();
    if (request.method !== 'POST') throw Errors.methodNotAllowed();

    await requireAuth(request, config);
    const provider = createProvider(config);

    const outcome =
      route === 'transcribe'
        ? await handleTranscribe(request, config, provider)
        : await handleTask(request, config, provider, startedAt);
    details = outcome.details;

    logLine({ route, ...details, status: 200, ms: Date.now() - startedAt });
    return jsonResponse({ ok: true, ...outcome.result }, 200, cors);
  } catch (error) {
    const appError = error instanceof AppError ? error : Errors.internal();
    logLine({
      route,
      ...details,
      status: appError.status,
      code: appError.code,
      // Para erros inesperados registra-se apenas o tipo (mensagens podem conter dados).
      errorType: error instanceof AppError ? undefined : error?.name,
      ms: Date.now() - startedAt,
    });
    return errorResponse(appError, cors);
  }
}
