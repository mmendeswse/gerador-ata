/**
 * Utilitários HTTP baseados somente em APIs Web padrão (Request/Response),
 * para que o mesmo código rode em Node.js, Vercel Functions e Cloudflare Workers.
 */

import { AppError, Errors } from './errors.js';

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Cabeçalhos CORS para a origem da requisição, conforme ALLOWED_ORIGINS. */
export function corsHeaders(request, config) {
  const origin = request.headers.get('Origin');
  const headers = {};

  if (config.allowedOrigins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && config.allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  } else {
    // Origem não autorizada: nenhum cabeçalho CORS é emitido e o navegador bloqueia a leitura.
    headers.Vary = 'Origin';
  }
  return headers;
}

export function preflightResponse(request, config) {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      ...corsHeaders(request, config),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export function jsonResponse(data, status, cors = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...cors,
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function errorResponse(error, cors = {}) {
  const appError = error instanceof AppError ? error : Errors.internal();
  const extraHeaders = {};
  if (appError.extra?.retryAfterSeconds) {
    extraHeaders['Retry-After'] = String(Math.ceil(appError.extra.retryAfterSeconds));
  }
  return jsonResponse(
    {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...appError.extra,
      },
    },
    appError.status,
    cors,
    extraHeaders,
  );
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante (sobre os hashes, que têm sempre o mesmo tamanho). */
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exige a senha de acesso (quando ACCESS_PASSWORD está definida).
 * O navegador envia: `Authorization: Bearer <senha>`.
 */
export async function requireAuth(request, config) {
  if (!config.accessPassword) return;

  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Errors.authRequired();

  let supplied = match[1].trim();
  try {
    // O frontend envia a senha codificada (permite acentos e símbolos no cabeçalho).
    supplied = decodeURIComponent(supplied);
  } catch {
    /* mantém o valor original */
  }

  if (!(await safeEqual(supplied, config.accessPassword))) {
    await sleep(400); // desacelera tentativas de força bruta
    throw Errors.authInvalid();
  }
}

/** Rejeita cedo corpos maiores que o limite, com base no Content-Length. */
export function assertContentLength(request, maxBytes) {
  const header = request.headers.get('Content-Length');
  if (!header) return;
  const length = Number.parseInt(header, 10);
  if (Number.isFinite(length) && length > maxBytes) {
    throw Errors.payloadTooLarge((maxBytes / 1024 / 1024).toFixed(1));
  }
}

export async function readJson(request, maxBytes) {
  assertContentLength(request, maxBytes);
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw Errors.badRequest('Não foi possível ler o corpo da requisição.');
  }
  if (raw.length > maxBytes) throw Errors.payloadTooLarge((maxBytes / 1024 / 1024).toFixed(1));
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw Errors.badRequest('O corpo da requisição não é um JSON válido.');
  }
}
