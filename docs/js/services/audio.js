/**
 * Extração de áudio NO NAVEGADOR com ffmpeg.wasm.
 *
 * O vídeo nunca é enviado pela internet. Aqui ele é lido diretamente do disco
 * (montagem WORKERFS, sem carregar o arquivo inteiro na memória), a faixa de
 * áudio é convertida para MP3 mono 16 kHz e dividida em trechos de ~10 min,
 * cortados preferencialmente em pausas de fala, para não partir palavras.
 *
 * Por que MP3 16 kHz mono? É o formato aceito por todos os serviços de
 * transcrição, e o Gemini reduz qualquer áudio a 16 kHz mono internamente.
 */

import { AppError, toAppError } from '../lib/errors.js';
import { getSettings } from '../settings.js';

const WRAPPER_URL = new URL('../../vendor/ffmpeg/ffmpeg.js', import.meta.url).href;

/** SHA-256 de @ffmpeg/core 0.12.10 (dist/umd). Protege contra adulteração na CDN. */
const CORE_SHA256 = {
  'ffmpeg-core.js': 'b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21',
  'ffmpeg-core.wasm': '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7',
};
const CORE_WASM_APPROX_BYTES = 32_300_000;

let wrapperPromise = null;
let coreUrlsPromise = null; // blobs do núcleo: baixados uma única vez por página

function loadWrapper() {
  if (window.FFmpegWASM?.FFmpeg) return Promise.resolve();
  if (!wrapperPromise) {
    wrapperPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = WRAPPER_URL;
      script.onload = () => (window.FFmpegWASM?.FFmpeg ? resolve() : reject(new Error('ffmpeg.js não expôs FFmpegWASM')));
      script.onerror = () => reject(new Error('Falha ao carregar vendor/ffmpeg/ffmpeg.js'));
      document.head.append(script);
    }).catch((error) => {
      wrapperPromise = null;
      throw error;
    });
  }
  return wrapperPromise;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchBytes(url, { onProgress, approxTotal, signal } = {}) {
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
  if (!response.body || !onProgress) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(Math.min(0.99, received / approxTotal), received);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function downloadCore({ onProgress, signal }) {
  const sources = getSettings().ffmpegCoreSources;
  const verify = Boolean(globalThis.crypto?.subtle) && window.APP_CONFIG?.FFMPEG_CORE_SKIP_INTEGRITY !== true;
  const errors = [];

  for (const source of sources) {
    const base = new URL(`${String(source).replace(/\/+$/, '')}/`, document.baseURI).href;
    try {
      const js = await fetchBytes(`${base}ffmpeg-core.js`, { signal });
      const wasm = await fetchBytes(`${base}ffmpeg-core.wasm`, { onProgress, approxTotal: CORE_WASM_APPROX_BYTES, signal });
      if (verify) {
        const [jsHash, wasmHash] = await Promise.all([sha256Hex(js), sha256Hex(wasm)]);
        if (jsHash !== CORE_SHA256['ffmpeg-core.js'] || wasmHash !== CORE_SHA256['ffmpeg-core.wasm']) {
          throw new Error(`Integridade não confere para ${base}`);
        }
      }
      return {
        coreURL: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })),
        wasmURL: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
      };
    } catch (error) {
      if (signal?.aborted) throw new AppError('CANCELED');
      errors.push(String(error?.message ?? error));
    }
  }
  throw new AppError('FFMPEG_LOAD_ERROR', { detail: errors.join(' | ') });
}

// ---------------------------------------------------------------------------
// Interpretação do log do ffmpeg
// ---------------------------------------------------------------------------

function clockToSeconds(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + Number.parseFloat(s);
}

class LogParser {
  constructor() {
    this.duration = null;
    this.time = 0;
    this.hasAudioStream = false;
    this.silences = [];
    this.pendingSilenceStart = null;
    this.meanVolume = null;
    this.maxVolume = null;
    this.tail = [];
  }

  push(message) {
    const line = String(message ?? '');
    this.tail.push(line);
    if (this.tail.length > 40) this.tail.shift();

    let m;
    if (this.duration === null && (m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/))) {
      this.duration = clockToSeconds(m[1], m[2], m[3]);
    }
    if (/Stream #\d+:\d+.*Audio:/.test(line)) this.hasAudioStream = true;
    if ((m = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/))) {
      this.time = Math.max(this.time, clockToSeconds(m[1], m[2], m[3]));
    }
    if ((m = line.match(/silence_start:\s*(-?[\d.]+)/))) this.pendingSilenceStart = Math.max(0, Number(m[1]));
    if ((m = line.match(/silence_end:\s*([\d.]+)/)) && this.pendingSilenceStart !== null) {
      this.silences.push({ start: this.pendingSilenceStart, end: Number(m[1]) });
      this.pendingSilenceStart = null;
    }
    if ((m = line.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/))) this.meanVolume = m[1] === '-inf' ? -Infinity : Number(m[1]);
    if ((m = line.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/))) this.maxVolume = m[1] === '-inf' ? -Infinity : Number(m[1]);
  }

  errorCode() {
    const text = this.tail.join('\n');
    if (/matches no streams|does not contain any stream|Output file #0 does not contain/i.test(text)) return 'NO_AUDIO';
    if (/out of memory|Cannot allocate memory/i.test(text)) return 'OUT_OF_MEMORY';
    return 'DECODE_ERROR';
  }
}

/**
 * Escolhe os pontos de corte: perto de cada múltiplo de `chunkSeconds`,
 * prefere o meio da pausa mais longa encontrada numa janela ao redor.
 */
export function planCuts(duration, chunkSeconds, silences) {
  const cuts = [];
  if (!Number.isFinite(duration) || duration <= chunkSeconds * 1.25) return cuts;
  const windowSeconds = Math.min(45, chunkSeconds * 0.12);
  let target = chunkSeconds;

  while (duration - target > chunkSeconds * 0.25) {
    let best = null;
    for (const silence of silences) {
      const middle = (silence.start + silence.end) / 2;
      if (middle < target - windowSeconds || middle > target + windowSeconds) continue;
      const length = silence.end - silence.start;
      if (!best || length > best.length + 0.15 || (Math.abs(length - best.length) <= 0.15 && Math.abs(middle - target) < Math.abs(best.middle - target))) {
        best = { middle, length };
      }
    }
    const cut = Number((best ? best.middle : target).toFixed(2));
    cuts.push(cut);
    target = cut + chunkSeconds;
  }
  return cuts;
}

// ---------------------------------------------------------------------------
// Extrator
// ---------------------------------------------------------------------------

export class AudioExtractor {
  constructor() {
    this.ffmpeg = null;
    this.parser = null;
    this.canceled = false;
    this.onLog = (event) => this.parser?.push(event.message);
  }

  async ensureLoaded({ onProgress, signal } = {}) {
    if (this.ffmpeg?.loaded) return this.ffmpeg;
    try {
      await loadWrapper();
    } catch (error) {
      throw new AppError('FFMPEG_LOAD_ERROR', { detail: String(error?.message ?? error) });
    }
    if (!coreUrlsPromise) {
      coreUrlsPromise = downloadCore({ onProgress, signal }).catch((error) => {
        coreUrlsPromise = null;
        throw error;
      });
    }
    const urls = await coreUrlsPromise;

    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    ffmpeg.on('log', this.onLog);
    try {
      await ffmpeg.load(urls);
    } catch (error) {
      throw new AppError('FFMPEG_LOAD_ERROR', { detail: String(error?.message ?? error) });
    }
    this.ffmpeg = ffmpeg;
    return ffmpeg;
  }

  /** Interrompe imediatamente qualquer operação em curso. */
  cancel() {
    this.canceled = true;
    this.dispose();
  }

  /** Libera a memória do WebAssembly (os blobs do núcleo ficam em cache para reuso). */
  dispose() {
    try {
      this.ffmpeg?.terminate();
    } catch {
      /* já encerrado */
    }
    this.ffmpeg = null;
  }

  async #exec(args) {
    try {
      return await this.ffmpeg.exec(args);
    } catch (error) {
      if (this.canceled) throw new AppError('CANCELED');
      throw toAppError(error);
    }
  }

  /**
   * @param {File} file
   * @param {{ chunkSeconds: number, bitrateKbps: number, onProgress?: Function, signal?: AbortSignal }} options
   * @returns {Promise<{ chunks: Array<{index:number,start:number,end:number,blob:Blob}>, duration:number, meanVolume:number|null, maxVolume:number|null }>}
   */
  async extract(file, { chunkSeconds, bitrateKbps, onProgress, signal }) {
    this.canceled = false;
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const ffmpeg = await this.ensureLoaded({
        signal,
        onProgress: (ratio, bytes) => onProgress?.({ phase: 'download', ratio, bytes }),
      });
      if (this.canceled) throw new AppError('CANCELED');

      const extension = (file.name.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ?? 'bin').toLowerCase();
      const inputName = `entrada.${extension}`; // nome neutro: evita problemas com acentos e símbolos
      const input = new File([file], inputName, { type: file.type });

      this.parser = new LogParser();
      await ffmpeg.createDir('/entrada');
      await ffmpeg.createDir('/saida');
      await ffmpeg.mount('WORKERFS', { files: [input] }, '/entrada');

      let finished = false;
      const ticker = setInterval(() => {
        if (finished || !this.parser) return;
        const total = this.parser.duration;
        onProgress?.({
          phase: 'extract',
          ratio: total ? Math.min(0.99, this.parser.time / total) : null,
          processedSeconds: this.parser.time,
          totalSeconds: total,
        });
      }, 400);

      let ret;
      try {
        ret = await this.#exec([
          '-hide_banner', '-nostdin', '-y',
          '-i', `/entrada/${inputName}`,
          '-map', '0:a:0', '-vn', '-sn', '-dn',
          '-af', 'silencedetect=noise=-32dB:d=0.4,volumedetect',
          '-ac', '1', '-ar', '16000',
          '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`,
          '-f', 'mp3', '/saida/completo.mp3',
        ]);
      } finally {
        finished = true;
        clearInterval(ticker);
      }

      const parser = this.parser;
      if (ret !== 0) throw new AppError(parser.errorCode(), { detail: parser.tail.slice(-8).join('\n') });

      const duration = parser.time || parser.duration || 0;
      if (!duration) throw new AppError('NO_AUDIO', { detail: 'Duração do áudio igual a zero.' });
      if (parser.maxVolume !== null && parser.maxVolume <= -55) {
        throw new AppError('SILENT_AUDIO', { detail: `Volume máximo: ${parser.maxVolume} dB` });
      }

      onProgress?.({ phase: 'split', ratio: null });
      const cuts = planCuts(duration, chunkSeconds, parser.silences);
      let names = ['completo.mp3'];
      if (cuts.length) {
        const splitRet = await this.#exec([
          '-hide_banner', '-nostdin', '-y',
          '-i', '/saida/completo.mp3',
          '-f', 'segment', '-segment_times', cuts.join(','),
          '-c', 'copy', '-reset_timestamps', '1',
          '/saida/trecho_%03d.mp3',
        ]);
        if (splitRet !== 0) throw new AppError('DECODE_ERROR', { detail: parser.tail.slice(-8).join('\n') });
        names = (await ffmpeg.listDir('/saida'))
          .filter((entry) => !entry.isDir && /^trecho_\d+\.mp3$/.test(entry.name))
          .map((entry) => entry.name)
          .sort();
        await ffmpeg.deleteFile('/saida/completo.mp3');
      }

      const blobs = [];
      for (const name of names) {
        const data = await ffmpeg.readFile(`/saida/${name}`);
        if (data.length > 0) blobs.push(new Blob([data], { type: 'audio/mpeg' }));
        await ffmpeg.deleteFile(`/saida/${name}`);
      }
      if (!blobs.length) throw new AppError('NO_AUDIO', { detail: 'Nenhum áudio foi produzido.' });

      // MP3 em taxa constante: a duração de cada trecho é proporcional ao seu tamanho.
      const totalBytes = blobs.reduce((sum, blob) => sum + blob.size, 0);
      let cursor = 0;
      const chunks = blobs.map((blob, index) => {
        const start = cursor;
        cursor += (blob.size / totalBytes) * duration;
        return { index, start, end: index === blobs.length - 1 ? duration : cursor, blob };
      });

      try {
        await ffmpeg.unmount('/entrada');
      } catch {
        /* a instância será encerrada de qualquer forma */
      }
      return { chunks, duration, meanVolume: parser.meanVolume, maxVolume: parser.maxVolume };
    } catch (error) {
      if (this.canceled || signal?.aborted) throw new AppError('CANCELED');
      throw toAppError(error);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.parser = null;
      this.dispose(); // devolve a memória usada pelo WebAssembly
    }
  }

  /** Divide um trecho ao meio (usado quando a IA não consegue transcrevê-lo inteiro). */
  async splitChunk(chunk, { signal } = {}) {
    this.canceled = false;
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const ffmpeg = await this.ensureLoaded({ signal });
      this.parser = new LogParser();
      const half = (chunk.end - chunk.start) / 2;
      await ffmpeg.writeFile('/dividir.mp3', new Uint8Array(await chunk.blob.arrayBuffer()));
      const first = await this.#exec(['-hide_banner', '-nostdin', '-y', '-i', '/dividir.mp3', '-t', half.toFixed(2), '-c', 'copy', '/parte_a.mp3']);
      const second = await this.#exec(['-hide_banner', '-nostdin', '-y', '-ss', half.toFixed(2), '-i', '/dividir.mp3', '-c', 'copy', '/parte_b.mp3']);
      if (first !== 0 || second !== 0) throw new AppError('DECODE_ERROR', { detail: this.parser.tail.slice(-6).join('\n') });
      const a = await ffmpeg.readFile('/parte_a.mp3');
      const b = await ffmpeg.readFile('/parte_b.mp3');
      const middle = chunk.start + half;
      return [
        { start: chunk.start, end: middle, blob: new Blob([a], { type: 'audio/mpeg' }) },
        { start: middle, end: chunk.end, blob: new Blob([b], { type: 'audio/mpeg' }) },
      ];
    } catch (error) {
      if (this.canceled || signal?.aborted) throw new AppError('CANCELED');
      throw toAppError(error);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.parser = null;
      this.dispose();
    }
  }
}
