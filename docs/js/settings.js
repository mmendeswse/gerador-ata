/**
 * Configurações da interface: valores de docs/config.js + preferências salvas
 * neste navegador (endereço do servidor, duração dos trechos e, se o usuário
 * pedir, a senha de acesso).
 */

const DEFAULTS = {
  API_BASE_URL: '',
  CHUNK_MINUTES: 10,
  AUDIO_BITRATE_KBPS: 40,
  MAX_FILE_SIZE_GB: 8,
  FFMPEG_CORE_SOURCES: [
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd',
  ],
};

const KEYS = {
  api: 'gam.apiBaseUrl',
  chunk: 'gam.chunkMinutes',
  password: 'gam.accessPassword',
};

function read(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null; // armazenamento bloqueado (modo privado, políticas do navegador)
  }
}

function write(storage, key, value) {
  try {
    if (value === null || value === undefined || value === '') storage.removeItem(key);
    else storage.setItem(key, String(value));
  } catch {
    /* sem armazenamento: a configuração vale só para esta página */
  }
}

/** Aceita "https://x.vercel.app/", "https://x.vercel.app/api" etc. e devolve a origem limpa. */
export function normalizeApiBase(value) {
  let url = String(value ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '').replace(/\/api$/i, '');
}

function clampChunk(value, fallback) {
  const minutes = Number.parseFloat(value);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.min(14, Math.max(3, minutes));
}

export function getSettings() {
  const fileConfig = { ...DEFAULTS, ...(window.APP_CONFIG ?? {}) };
  const storedApi = readApiOverride();
  const storedChunk = read(localStorage, KEYS.chunk);

  return {
    apiBaseUrl: normalizeApiBase(storedApi !== null ? storedApi : fileConfig.API_BASE_URL),
    apiBaseUrlIsCustom: storedApi !== null,
    chunkMinutes: clampChunk(storedChunk ?? fileConfig.CHUNK_MINUTES, DEFAULTS.CHUNK_MINUTES),
    audioBitrateKbps: [24, 32, 40, 48, 56, 64].includes(Number(fileConfig.AUDIO_BITRATE_KBPS))
      ? Number(fileConfig.AUDIO_BITRATE_KBPS)
      : DEFAULTS.AUDIO_BITRATE_KBPS,
    maxFileSizeBytes: Math.max(0.05, Number(fileConfig.MAX_FILE_SIZE_GB) || DEFAULTS.MAX_FILE_SIZE_GB) * 1024 ** 3,
    ffmpegCoreSources:
      Array.isArray(fileConfig.FFMPEG_CORE_SOURCES) && fileConfig.FFMPEG_CORE_SOURCES.length
        ? fileConfig.FFMPEG_CORE_SOURCES
        : DEFAULTS.FFMPEG_CORE_SOURCES,
  };
}

/** O endereço digitado em "Configurações" é guardado como JSON para distinguir "vazio" de "não definido". */
function readApiOverride() {
  const raw = read(localStorage, KEYS.api);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.url === 'string' ? parsed.url : null;
  } catch {
    return null;
  }
}

export function saveSettings({ apiBaseUrl, chunkMinutes }) {
  const normalized = normalizeApiBase(apiBaseUrl);
  const fromFile = normalizeApiBase((window.APP_CONFIG ?? {}).API_BASE_URL);
  // Só grava quando difere do config.js, para que atualizações daquele arquivo continuem valendo.
  write(localStorage, KEYS.api, normalized === fromFile ? null : JSON.stringify({ url: normalized }));
  write(localStorage, KEYS.chunk, clampChunk(chunkMinutes, DEFAULTS.CHUNK_MINUTES));
}

export function getPassword() {
  return read(sessionStorage, KEYS.password) ?? read(localStorage, KEYS.password) ?? '';
}

export function isPasswordRemembered() {
  return read(localStorage, KEYS.password) !== null;
}

export function setPassword(value, remember) {
  write(sessionStorage, KEYS.password, value);
  write(localStorage, KEYS.password, remember ? value : null);
}
