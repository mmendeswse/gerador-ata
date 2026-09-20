/**
 * Provedor LOCAL (AI_PROVIDER=local): nenhum serviço externo, nenhuma chave.
 *
 * - Transcrição: whisper.cpp (binário nativo, sem Python), lendo o MP3 do
 *   trecho e devolvendo segmentos com horários. A SEPARAÇÃO DE VOZES não está
 *   disponível neste modo: todos os segmentos saem com o rótulo "Voz 1" e a
 *   identificação de participantes passa a depender apenas do contexto das
 *   falas (apresentações, vocativos), como os prompts já preveem.
 * - Redação e análise: Ollama (http://127.0.0.1:11434), com saída estruturada
 *   (JSON Schema) nas tarefas que exigem JSON.
 *
 * Os módulos do Node (child_process, fs...) são importados dinamicamente para
 * que este arquivo possa ser empacotado no Cloudflare Workers sem quebrar —
 * lá o modo local nunca é usado.
 */

import { Buffer } from 'node:buffer';
import { AppError, Errors } from '../errors.js';

/** Rótulo único de voz usado na transcrição local (sem diarização). */
export const LOCAL_VOICE_LABEL = 'Voz 1';

/** Pausa (s) que separa dois blocos de fala e tamanho máximo de um bloco. */
const MERGE_GAP_SECONDS = 2;
const MERGE_MAX_CHARS = 700;

/**
 * Converte um esquema no estilo Gemini (tipos em MAIÚSCULAS, propertyOrdering)
 * para JSON Schema padrão, aceito pelo campo `format` do Ollama.
 */
export function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'propertyOrdering') continue;
    if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase();
    else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [name, sub] of Object.entries(value)) out.properties[name] = toJsonSchema(sub);
    } else if (key === 'items') out.items = toJsonSchema(value);
    else out[key] = value;
  }
  return out;
}

function toClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Converte a saída JSON do whisper.cpp (opção -oj) para o mesmo JSON de
 * transcrição que o provedor Gemini devolve. Frases consecutivas são reunidas
 * em blocos, separando-os nas pausas mais longas, para que a numeração de
 * segmentos fique próxima de "uma fala por segmento".
 */
export function whisperToTranscription(whisperJson) {
  const items = Array.isArray(whisperJson?.transcription) ? whisperJson.transcription : [];

  const blocks = [];
  let current = null;
  for (const item of items) {
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || /^\[[^\]]*\]$/.test(text)) continue; // descarta marcações como [Música]
    const fromMs = Number(item?.offsets?.from);
    const toMs = Number(item?.offsets?.to);
    const start = Number.isFinite(fromMs) ? fromMs / 1000 : (current ? current.end : 0);
    const end = Number.isFinite(toMs) ? toMs / 1000 : start;

    const gap = current ? start - current.end : Infinity;
    if (current && gap < MERGE_GAP_SECONDS && current.text.length + text.length + 1 <= MERGE_MAX_CHARS) {
      current.text += ` ${text}`;
      current.end = Math.max(current.end, end);
    } else {
      current = { start, end, text };
      blocks.push(current);
    }
  }

  return {
    segmentos: blocks.map((block) => ({
      inicio: toClock(block.start),
      falante: LOCAL_VOICE_LABEL,
      texto: block.text,
    })),
    falantes: blocks.length
      ? [{
          rotulo: LOCAL_VOICE_LABEL,
          descricao: 'Transcrição local (Whisper): as vozes não são separadas neste modo.',
          nome_provavel: '',
          evidencia_nome: '',
        }]
      : [],
    qualidade_audio: blocks.length ? 'regular' : 'sem_fala',
    observacoes: blocks.length
      ? 'Transcrição feita localmente pelo Whisper, sem separação de vozes: identifique os participantes pelo contexto (apresentações, vocativos, anúncios da Presidência).'
      : '',
  };
}

/** Executa um processo com limite de tempo; devolve o stderr acumulado em caso de erro. */
async function runProcess(command, args, timeoutMs) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      reject(Errors.serverNotConfigured(`Não foi possível executar o Whisper em "${command}".`));
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(Errors.aiTimeout());
    }, Math.max(5000, timeoutMs));

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        error?.code === 'ENOENT'
          ? Errors.serverNotConfigured(
              `O executável do Whisper não foi encontrado em "${command}". Confira WHISPER_CLI no arquivo .env (o instalador em instalacao-local/ faz isso por você).`,
            )
          : Errors.aiError(String(error?.message ?? error).slice(0, 300)),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Errors.aiError(`Whisper terminou com código ${code}. ${stderr.replace(/\s+/g, ' ').slice(0, 300)}`));
    });
  });
}

async function callOllama(config, { system, user, schema, json }) {
  const body = {
    model: config.ollamaModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    keep_alive: '30m',
    options: { temperature: 0.2, num_ctx: config.ollamaNumCtx },
  };
  if (json) body.format = schema ? toJsonSchema(schema) : 'json';

  let response;
  try {
    response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestBudgetMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw Errors.aiTimeout();
    throw Errors.serverNotConfigured(
      `Não foi possível falar com o Ollama em ${config.ollamaUrl}. Ele está instalado e em execução? (O instalador em instalacao-local/ cuida disso.)`,
    );
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.status === 404) throw Errors.aiModelNotFound(config.ollamaModel);
  if (!response.ok) {
    const message = String(data?.error ?? '').replace(/\s+/g, ' ').slice(0, 300);
    if (/not found|pull/i.test(message)) throw Errors.aiModelNotFound(config.ollamaModel);
    throw Errors.aiError(message || `Ollama respondeu com status ${response.status}.`);
  }

  const text = String(data?.message?.content ?? '');
  const truncated = data?.done_reason === 'length';
  return {
    text,
    finishReason: truncated ? 'MAX_TOKENS' : 'STOP',
    truncated,
    partiallyBlocked: false,
    model: config.ollamaModel,
    usage: {
      inputTokens: data?.prompt_eval_count ?? null,
      outputTokens: data?.eval_count ?? null,
      thinkingTokens: null,
      totalTokens:
        Number.isFinite(data?.prompt_eval_count) && Number.isFinite(data?.eval_count)
          ? data.prompt_eval_count + data.eval_count
          : null,
    },
  };
}

export function createLocalProvider(config) {
  return {
    name: 'local',

    /** @param {{ audio: ArrayBuffer }} input */
    async transcribe({ audio }) {
      if (!config.whisperCli || !config.whisperModel) {
        throw Errors.serverNotConfigured(
          'Modo local: defina WHISPER_CLI e WHISPER_MODEL no arquivo .env (o instalador em instalacao-local/ faz isso por você).',
        );
      }
      const [{ mkdtemp, writeFile, readFile, rm }, { tmpdir }, { join, basename }] = await Promise.all([
        import('node:fs/promises'),
        import('node:os'),
        import('node:path'),
      ]);

      const dir = await mkdtemp(join(tmpdir(), 'gam-'));
      try {
        const audioFile = join(dir, 'trecho.mp3');
        const outPrefix = join(dir, 'transcricao');
        await writeFile(audioFile, Buffer.from(audio));
        await runProcess(
          config.whisperCli,
          [
            '-m', config.whisperModel,
            '-f', audioFile,
            '-l', config.whisperLanguage,
            '-t', String(config.whisperThreads),
            '-oj',
            '-of', outPrefix,
            '-np',
          ],
          config.requestBudgetMs,
        );
        const raw = await readFile(`${outPrefix}.json`, 'utf8');
        const bodyJson = whisperToTranscription(JSON.parse(raw));
        return {
          text: JSON.stringify(bodyJson),
          finishReason: 'STOP',
          truncated: false,
          partiallyBlocked: false,
          model: `whisper.cpp (${basename(config.whisperModel)})`,
          usage: {},
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw Errors.aiError(String(error?.message ?? error).slice(0, 300));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    async generateJson({ system, user, schema }) {
      return callOllama(config, { system, user, schema, json: true });
    },

    async generateText({ system, user }) {
      return callOllama(config, { system, user, json: false });
    },
  };
}
