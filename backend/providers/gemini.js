/**
 * Provedor Google Gemini (API generateContent, sem estado).
 *
 * - A chave de API vem da variável de ambiente GEMINI_API_KEY e é enviada
 *   somente no cabeçalho `x-goog-api-key` (nunca em URL, log ou resposta).
 * - O áudio segue embutido na requisição (inlineData): nada é gravado na
 *   Files API do Google e `store: false` desativa o registro da requisição.
 * - Modelos indisponíveis (404) são substituídos pelo próximo da lista.
 * - Erros 5xx são repetidos com espera; 429 devolve ao navegador o tempo de
 *   espera sugerido, para que ele aguarde mostrando uma contagem ao usuário.
 */

import { Buffer } from 'node:buffer';
import { Errors } from '../errors.js';

const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

const AUDIO_PLACEHOLDER = '__AUDIO_BASE64_PLACEHOLDER__';
const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'LANGUAGE',
]);

// Memória por instância: nível de compatibilidade que funcionou para cada modelo.
const compatibilityLevel = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Monta o corpo da requisição. `level` remove progressivamente campos
 * opcionais caso a API os recuse (compatibilidade com modelos futuros):
 *   0 = completo; 1 = sem `store`/`thinkingConfig`; 2 = sem esquema, sem safetySettings.
 */
function buildBody(request, config, level) {
  const generationConfig = {};
  if (level < 2) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.json) generationConfig.responseMimeType = 'application/json';
  if (request.json && request.schema && level < 2) generationConfig.responseSchema = request.schema;
  if (config.temperature !== null) generationConfig.temperature = config.temperature;
  if (config.thinkingLevel && level < 1) {
    generationConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel };
  }

  const parts = [];
  if (request.audio) {
    parts.push({ inlineData: { mimeType: request.audio.mimeType, data: AUDIO_PLACEHOLDER } });
  }
  parts.push({ text: request.user });

  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  if (level < 2) body.safetySettings = SAFETY_SETTINGS;
  if (level < 1) body.store = false;

  let serialized = JSON.stringify(body);
  if (request.audio) {
    // Evita percorrer/escapar megabytes de base64 dentro do JSON.stringify.
    serialized = serialized.replace(`"${AUDIO_PLACEHOLDER}"`, () => `"${request.audio.base64}"`);
  }
  return serialized;
}

function parseRetryDelaySeconds(errorBody) {
  for (const detail of errorBody?.error?.details ?? []) {
    if (typeof detail?.retryDelay === 'string') {
      const seconds = Number.parseFloat(detail.retryDelay);
      if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
    }
  }
  const match = String(errorBody?.error?.message ?? '').match(/retry in ([\d.]+)\s*s/i);
  return match ? Math.max(1, Math.ceil(Number.parseFloat(match[1]))) : null;
}

function isDailyQuota(errorBody) {
  const serialized = JSON.stringify(errorBody?.error?.details ?? []);
  return /PerDay|per_day|daily/i.test(serialized);
}

function isZeroLimit(errorBody) {
  return /limit:\s*0\b/i.test(String(errorBody?.error?.message ?? ''));
}

function safeDetail(errorBody) {
  // Mensagens do Google descrevem o erro técnico (não ecoam o conteúdo enviado).
  return String(errorBody?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

function extractResult(data, model) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) throw Errors.aiBlocked(blockReason);
    throw Errors.aiBadResponse();
  }
  const finishReason = candidate.finishReason || 'STOP';
  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');

  if (BLOCKING_FINISH_REASONS.has(finishReason) && !text.trim()) {
    throw Errors.aiBlocked(finishReason);
  }

  const usage = data.usageMetadata ?? {};
  return {
    text,
    finishReason,
    truncated: finishReason === 'MAX_TOKENS',
    partiallyBlocked: BLOCKING_FINISH_REASONS.has(finishReason),
    model,
    usage: {
      inputTokens: usage.promptTokenCount ?? null,
      outputTokens: usage.candidatesTokenCount ?? null,
      thinkingTokens: usage.thoughtsTokenCount ?? null,
      totalTokens: usage.totalTokenCount ?? null,
    },
  };
}

async function callModel(model, request, config, deadline) {
  let level = compatibilityLevel.get(model) ?? 0;
  let serverErrors = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) throw Errors.aiTimeout();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining - 1500);
    let response;
    try {
      response = await fetch(`${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
        body: buildBody(request, config, level),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw Errors.aiTimeout();
      serverErrors += 1;
      if (serverErrors > 2) throw Errors.aiUnavailable();
      await sleep(1500 * serverErrors);
      continue;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      compatibilityLevel.set(model, level);
      if (!payload) throw Errors.aiBadResponse();
      return extractResult(payload, model);
    }

    const status = response.status;
    const message = String(payload?.error?.message ?? '');

    if (status === 404) return null; // modelo inexistente: o chamador tenta o próximo
    if (status === 401 || status === 403 || /api key not valid|api_key_invalid/i.test(message)) {
      throw Errors.aiAuth();
    }
    if (status === 429) {
      if (isZeroLimit(payload)) return null; // modelo fora da cota deste projeto: tenta o próximo
      if (isDailyQuota(payload)) throw Errors.aiQuotaExhausted();
      throw Errors.aiRateLimit(parseRetryDelaySeconds(payload) ?? 30);
    }
    if (status >= 500) {
      serverErrors += 1;
      if (serverErrors > 2) throw Errors.aiUnavailable();
      await sleep(2000 * serverErrors);
      continue;
    }
    if (status === 400 && level < 2) {
      level += 1; // remove campos opcionais e tenta de novo
      continue;
    }
    throw Errors.aiError(safeDetail(payload));
  }
}

async function generate(request, models, config) {
  if (!config.geminiApiKey) throw Errors.serverNotConfigured();
  const deadline = Date.now() + config.requestBudgetMs;

  for (const model of models) {
    const result = await callModel(model, request, config, deadline);
    if (result) return result;
  }
  throw Errors.aiModelNotFound(models.join(', '));
}

export function createGeminiProvider(config) {
  return {
    name: 'gemini',

    /** @param {{ audio: ArrayBuffer, system: string, user: string, schema: object }} input */
    async transcribe({ audio, system, user, schema }) {
      return generate(
        {
          system,
          user,
          schema,
          json: true,
          maxOutputTokens: 65536,
          // A documentação do Gemini lista "audio/mp3" como tipo aceito para MP3.
          audio: { mimeType: 'audio/mp3', base64: Buffer.from(audio).toString('base64') },
        },
        config.transcriptionModels,
        config,
      );
    },

    async generateJson({ system, user, schema }) {
      return generate(
        { system, user, schema, json: true, maxOutputTokens: 32768 },
        config.textModels,
        config,
      );
    },

    async generateText({ system, user }) {
      return generate({ system, user, json: false, maxOutputTokens: 32768 }, config.textModels, config);
    },
  };
}
