/**
 * Cliente do servidor de processamento (backend).
 *
 * - Nenhuma chave de API existe no navegador: só o endereço do servidor e,
 *   se houver, a senha de acesso digitada pelo usuário.
 * - Trata tempo limite, queda de conexão, limite de uso (espera e repete
 *   sozinho, avisando a interface) e pedido de senha.
 */

import { AppError, TRANSIENT_CODES } from '../lib/errors.js';
import { getPassword, getSettings } from '../settings.js';

const TIMEOUT_MS = { health: 15_000, transcribe: 295_000, task: 295_000 };
const MAX_RATE_LIMIT_WAITS = 8;
const MAX_TRANSIENT_RETRIES = 2;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('CANCELED'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('CANCELED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function endpoint(path) {
  return `${getSettings().apiBaseUrl}/api/${path}`;
}

function authHeaders() {
  const password = getPassword();
  // encodeURIComponent permite acentos e símbolos na senha (cabeçalhos HTTP são ASCII).
  return password ? { Authorization: `Bearer ${encodeURIComponent(password)}` } : {};
}

/** Uma chamada HTTP, com tempo limite e conversão de falhas em AppError. */
async function request(path, { method = 'GET', body, headers = {}, timeoutMs, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetch(endpoint(path), {
      method,
      body,
      headers: { ...authHeaders(), ...headers },
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (timedOut) throw new AppError('TIMEOUT');
    if (signal?.aborted) throw new AppError('CANCELED');
    throw new AppError('NETWORK_ERROR', { detail: String(error?.message ?? error), cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let data = null;
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (response.ok && data && data.ok !== false) return data;

  // Erro padronizado do nosso backend
  if (data?.error?.code) {
    throw new AppError(data.error.code, {
      detail: [data.error.message, data.error.detail, data.error.reason].filter(Boolean).join(' — '),
      retryAfterSeconds: data.error.retryAfterSeconds,
    });
  }

  // Erros gerados pela hospedagem (antes de chegar ao nosso código)
  const status = response.status;
  if (status === 413) throw new AppError('PAYLOAD_TOO_LARGE', { detail: `HTTP ${status}` });
  if (status === 504 || status === 408) throw new AppError('TIMEOUT', { detail: `HTTP ${status}` });
  if (status === 404 || status === 405) {
    throw new AppError('BACKEND_NOT_CONFIGURED', { detail: `O endereço ${endpoint(path)} respondeu HTTP ${status}.` });
  }
  if (status === 429) throw new AppError('AI_RATE_LIMIT', { retryAfterSeconds: 30, detail: `HTTP ${status}` });
  if (status >= 500) throw new AppError('INTERNAL', { detail: `HTTP ${status}` });
  if (response.ok) throw new AppError('BACKEND_NOT_CONFIGURED', { detail: 'A resposta não veio do servidor de processamento (conteúdo inesperado).' });
  throw new AppError('AI_ERROR', { detail: `HTTP ${status}` });
}

/**
 * Executa `attempt` repetindo quando faz sentido:
 *  - limite de uso da IA: espera o tempo sugerido (com contagem na tela) e repete;
 *  - falhas passageiras (rede, indisponibilidade, tempo limite): até 2 novas tentativas;
 *  - senha ausente/incorreta: pede a senha ao usuário e repete.
 */
async function withRetries(attempt, { signal, onWait, onAuthRequired } = {}) {
  let rateLimitWaits = 0;
  let transientRetries = 0;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;

      if (error.code === 'AI_RATE_LIMIT' && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
        rateLimitWaits += 1;
        const seconds = Math.min(180, Math.max(2, Math.ceil(error.retryAfterSeconds ?? 30) + 1));
        for (let left = seconds; left > 0; left -= 1) {
          onWait?.({ reason: 'rate_limit', secondsLeft: left });
          await sleep(1000, signal);
        }
        onWait?.(null);
        continue;
      }

      if (TRANSIENT_CODES.has(error.code) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries += 1;
        const seconds = transientRetries === 1 ? 4 : 12;
        for (let left = seconds; left > 0; left -= 1) {
          onWait?.({ reason: 'retry', secondsLeft: left, code: error.code });
          await sleep(1000, signal);
        }
        onWait?.(null);
        continue;
      }

      if ((error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID') && onAuthRequired) {
        const provided = await onAuthRequired(error.code);
        if (provided) continue;
      }
      throw error;
    }
  }
}

export const api = {
  /** Situação do servidor. `withAuth` valida a senha sem gastar chamadas de IA. */
  async health({ signal } = {}) {
    return request('health', { timeoutMs: TIMEOUT_MS.health, signal });
  },

  /** Transcreve um trecho de áudio. */
  async transcribe(blob, meta, options = {}) {
    return withRetries(() => {
      const form = new FormData();
      form.set('audio', blob, `trecho-${String(meta.chunkIndex + 1).padStart(3, '0')}.mp3`);
      form.set('meta', JSON.stringify(meta));
      return request('transcribe', { method: 'POST', body: form, timeoutMs: TIMEOUT_MS.transcribe, signal: options.signal });
    }, options);
  },

  /** Executa uma tarefa de análise/redação/revisão. */
  async task(task, payload, options = {}) {
    return withRetries(
      () =>
        request('task', {
          method: 'POST',
          body: JSON.stringify({ task, payload }),
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: TIMEOUT_MS.task,
          signal: options.signal,
        }),
      options,
    );
  },
};
