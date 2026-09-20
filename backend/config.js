/**
 * Leitura e validação da configuração do backend a partir das variáveis de
 * ambiente. A chave de API existe SOMENTE aqui (lado do servidor) e nunca é
 * enviada ao navegador.
 *
 * O objeto `env` é `process.env` no Node/Vercel e o parâmetro `env` no
 * Cloudflare Workers.
 */

export const APP_VERSION = '1.0.0';

const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_FALLBACK_MODELS = 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-2.5-flash';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return text(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function number(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseFloat(text(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

/** Remove barra final e caminho de uma origem (ex.: https://usuario.github.io/repo/ -> https://usuario.github.io). */
function normalizeOrigin(value) {
  if (value === '*') return '*';
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

export function loadConfig(env = {}) {
  const provider = (text(env.AI_PROVIDER) || 'gemini').toLowerCase();

  const baseModel = text(env.GEMINI_MODEL) || DEFAULT_MODEL;
  const fallbacks = list(env.GEMINI_FALLBACK_MODELS ?? DEFAULT_FALLBACK_MODELS);
  const transcriptionModel = text(env.GEMINI_TRANSCRIPTION_MODEL) || baseModel;
  const textModel = text(env.GEMINI_TEXT_MODEL) || baseModel;

  const allowedOrigins = list(env.ALLOWED_ORIGINS).map(normalizeOrigin);
  const temperatureRaw = text(env.GEMINI_TEMPERATURE);
  const thinkingLevel = text(env.GEMINI_THINKING_LEVEL).toLowerCase();

  return {
    version: APP_VERSION,
    provider,
    providerLabel:
      provider === 'mock'
        ? 'Modo de teste (sem IA)'
        : provider === 'local'
          ? 'IA local (Whisper + Ollama)'
          : 'Google Gemini',

    geminiApiKey: text(env.GEMINI_API_KEY),
    geminiBaseUrl:
      text(env.GEMINI_BASE_URL).replace(/\/+$/, '') ||
      'https://generativelanguage.googleapis.com/v1beta',
    transcriptionModels: unique([transcriptionModel, ...fallbacks]),
    textModels: unique([textModel, ...fallbacks]),
    temperature: temperatureRaw === '' ? null : number(temperatureRaw, null, { min: 0, max: 2 }),
    thinkingLevel: ['low', 'medium', 'high'].includes(thinkingLevel) ? thinkingLevel : null,

    accessPassword: text(env.ACCESS_PASSWORD),
    allowedOrigins: allowedOrigins.length ? allowedOrigins : ['*'],

    // Limites de entrada (defesa contra abuso e contra estouro dos limites da hospedagem).
    // Tamanho máximo de cada trecho de áudio. O padrão (4 MB) respeita o limite de 4,5 MB por
    // requisição da Vercel; a interface ajusta a duração dos trechos a este valor. Em Cloudflare
    // Workers ou servidor próprio pode ser aumentado, mas nunca além de 14 MB: o Gemini aceita no
    // máximo 20 MB por requisição com áudio embutido, e a codificação base64 acrescenta ~33%.
    maxAudioBytes: Math.round(number(env.MAX_AUDIO_MB, 4, { min: 1, max: 14 }) * 1024 * 1024),
    maxJsonBytes: Math.round(number(env.MAX_JSON_MB, 4, { min: 1, max: 50 }) * 1024 * 1024),

    // Orçamento de tempo por requisição (a Vercel encerra funções em 300 s).
    requestBudgetMs: Math.round(number(env.REQUEST_BUDGET_SECONDS, 280, { min: 20, max: 1700 }) * 1000),

    // Modo local (AI_PROVIDER=local): whisper.cpp + Ollama, sem serviço externo.
    whisperCli: text(env.WHISPER_CLI),
    whisperModel: text(env.WHISPER_MODEL),
    whisperLanguage: text(env.WHISPER_LANGUAGE) || 'pt',
    whisperThreads: Math.round(number(env.WHISPER_THREADS, 4, { min: 1, max: 32 })),
    ollamaUrl: text(env.OLLAMA_URL).replace(/\/+$/, '') || 'http://127.0.0.1:11434',
    ollamaModel: text(env.OLLAMA_MODEL) || 'llama3.1:8b',
    ollamaNumCtx: Math.round(number(env.OLLAMA_NUM_CTX, 16384, { min: 2048, max: 131072 })),

    // Apenas para testes automatizados do provedor simulado.
    mockDelayMs: Math.round(number(env.MOCK_DELAY_MS, 350, { min: 0, max: 10000 })),
    mockScenario: text(env.MOCK_SCENARIO),
  };
}

/** Informações públicas (sem segredos) devolvidas por /api/health. */
export function publicInfo(config) {
  return {
    ok: true,
    version: config.version,
    provider: config.provider,
    providerLabel: config.providerLabel,
    model:
      config.provider === 'mock'
        ? 'simulado'
        : config.provider === 'local'
          ? config.ollamaModel
          : config.textModels[0],
    transcriptionModel:
      config.provider === 'mock'
        ? 'simulado'
        : config.provider === 'local'
          ? 'whisper.cpp'
          : config.transcriptionModels[0],
    configured:
      config.provider === 'mock' ||
      (config.provider === 'local'
        ? Boolean(config.whisperCli && config.whisperModel)
        : Boolean(config.geminiApiKey)),
    requiresPassword: Boolean(config.accessPassword),
    corsOpen: config.allowedOrigins.includes('*'),
    maxAudioBytes: config.maxAudioBytes,
  };
}
