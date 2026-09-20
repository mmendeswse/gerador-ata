/**
 * Orquestração do processamento da reunião (as 10 etapas exibidas na tela).
 *
 * O estado de cada etapa fica guardado em `job`. Se algo falhar (queda de
 * conexão, limite de uso da IA, senha...), basta chamar run() de novo: as
 * etapas já concluídas — inclusive os trechos já transcritos — são
 * reaproveitadas, sem novo custo.
 */

import { AppError, toAppError } from '../lib/errors.js';
import { formatClock, formatDuration } from '../lib/format.js';
import { getSettings } from '../settings.js';
import { api } from './api.js';
import { AudioExtractor } from './audio.js';

export const STEPS = [
  { id: 'prepare', label: 'Preparando vídeo', weight: 3 },
  { id: 'extract', label: 'Extraindo áudio', weight: 12 },
  { id: 'transcribe', label: 'Transcrevendo reunião', weight: 45 },
  { id: 'participants', label: 'Identificando participantes', weight: 5 },
  { id: 'analyze', label: 'Analisando reunião', weight: 7 },
  { id: 'deliberations', label: 'Identificando deliberações', weight: 6 },
  { id: 'ata', label: 'Gerando Ata', weight: 8 },
  { id: 'momento_identify', label: 'Identificando Momento Aberto', weight: 4 },
  { id: 'momento', label: 'Gerando Momento Aberto', weight: 6 },
  { id: 'finalize', label: 'Finalizando', weight: 4 },
];

const DEFAULT_SERVER_AUDIO_LIMIT = 4 * 1024 * 1024; // limite seguro para a Vercel (4,5 MB por requisição)
const MIN_SPLITTABLE_SECONDS = 150;

function emptyJob() {
  return {
    fileKey: null,
    fileName: '',
    audio: null, // { duration, meanVolume, maxVolume }
    pending: null, // trechos ainda não transcritos [{ start, end, blob }]
    done: [], // trechos transcritos [{ start, end, segments, quality }]
    roster: [],
    segments: null,
    participants: null,
    mentioned: [],
    participantsEdited: false,
    analysis: null,
    items: null,
    itemsSummary: null,
    ata: null,
    locate: null,
    scope: null,
    momento: null,
    review: { ata: null, momento: null, aiReviewed: null },
    warnings: [],
  };
}

export function fileKeyOf(file) {
  return file ? `${file.name}|${file.size}|${file.lastModified}` : null;
}

export class MeetingPipeline {
  /**
   * @param {{ onEvent: (event: object) => void, requestPassword: (code: string) => Promise<boolean> }} hooks
   */
  constructor({ onEvent, requestPassword }) {
    this.onEvent = onEvent;
    this.requestPassword = requestPassword;
    this.job = emptyJob();
    this.extractor = new AudioExtractor();
    this.controller = null;
    this.running = false;
    this.serverInfo = null;
  }

  // ------------------------------------------------------------------ estado
  hasTranscript(file) {
    return Boolean(this.job.segments?.length) && (!file || this.job.fileKey === fileKeyOf(file));
  }

  hasPartialWork(file) {
    return this.job.fileKey === fileKeyOf(file) && (this.job.done.length > 0 || Boolean(this.job.audio));
  }

  reset() {
    this.job = emptyJob();
  }

  /** Dados para a interface e para guardar na sessão do navegador (sem áudio). */
  snapshot() {
    const { job } = this;
    return {
      fileKey: job.fileKey,
      fileName: job.fileName,
      duration: job.audio?.duration ?? null,
      roster: job.roster,
      segments: job.segments,
      participants: job.participants,
      mentioned: job.mentioned,
      analysis: job.analysis,
      items: job.items,
      itemsSummary: job.itemsSummary,
      ata: job.ata,
      locate: job.locate,
      scope: job.scope,
      momento: job.momento,
      review: job.review,
      warnings: job.warnings,
    };
  }

  /** Restaura resultados guardados na sessão (permite gerar novamente sem o vídeo). */
  restore(saved) {
    this.job = { ...emptyJob(), ...saved, pending: null, done: [], audio: saved.duration ? { duration: saved.duration } : null };
    this.job.review = saved.review ?? { ata: null, momento: null, aiReviewed: null };
    this.job.warnings = saved.warnings ?? [];
  }

  setParticipants(participants) {
    this.job.participants = participants;
    this.job.participantsEdited = true;
  }

  /** Apaga os resultados a partir de uma etapa, para que sejam refeitos. */
  invalidateFrom(stepId) {
    const { job } = this;
    const order = STEPS.map((step) => step.id);
    const from = order.indexOf(stepId);
    const clearIf = (id, action) => {
      if (order.indexOf(id) >= from) action();
    };
    clearIf('extract', () => {
      job.audio = null;
      job.pending = null;
    });
    clearIf('transcribe', () => {
      job.done = [];
      job.roster = [];
      job.segments = null;
      job.pending = null;
      job.audio = null;
    });
    clearIf('participants', () => {
      job.participants = null;
      job.mentioned = [];
      job.participantsEdited = false;
    });
    clearIf('analyze', () => (job.analysis = null));
    clearIf('deliberations', () => {
      job.items = null;
      job.itemsSummary = null;
    });
    clearIf('ata', () => {
      job.ata = null;
      job.review.ata = null;
    });
    clearIf('momento_identify', () => {
      job.locate = null;
      job.scope = null;
    });
    clearIf('momento', () => {
      job.momento = null;
      job.review.momento = null;
    });
    job.warnings = job.warnings.filter((warning) => order.indexOf(warning.step) < from);
  }

  /**
   * Prepara a nova redação de UM documento, preservando o outro.
   * @returns {string[]} etapas que devem ser executadas
   */
  prepareRegeneration(kind, scopeMode) {
    const { job } = this;
    let only;
    if (kind === 'ata') {
      job.ata = null;
      job.review.ata = null;
      only = ['ata', 'finalize'];
    } else {
      job.momento = null;
      job.review.momento = null;
      const wantsWholeMeeting = scopeMode === 'all';
      const isWholeMeetingByUser = job.scope?.mode === 'reuniao_inteira' && job.scope?.chosenByUser === true;
      if (wantsWholeMeeting !== isWholeMeetingByUser) {
        job.scope = null; // a opção do formulário mudou: localiza o período de novo
        job.locate = null;
      }
      only = ['momento_identify', 'momento', 'finalize'];
    }
    job.warnings = job.warnings.filter((warning) => !only.includes(warning.step));
    return only;
  }

  cancel() {
    this.controller?.abort();
    this.extractor.cancel();
  }

  // --------------------------------------------------------------- execução
  /**
   * @param {{ file: File|null, meetingInfo: object, scopeMode: 'auto'|'all', only?: string[], extraInstructions?: {ata?: string, momento?: string} }} input
   *   `only`: lista de etapas a executar (usada em "Gerar novamente"); as demais são mantidas.
   *   `extraInstructions`: orientações adicionais do usuário para a nova redação.
   *   `keepJob`: preserva a transcrição em memória mesmo que outro arquivo esteja selecionado.
   * @returns {Promise<{ ok: true, results: object } | { ok: false, error: AppError, stepId?: string }>}
   */
  async run({ file, meetingInfo, scopeMode, only = null, extraInstructions = null, keepJob = false }) {
    if (this.running) return { ok: false, error: new AppError('PROCESSING_ERROR', { detail: 'Já existe um processamento em andamento.' }) };
    this.running = true;
    this.controller = new AbortController();
    const context = { file, meetingInfo, scopeMode, extraInstructions, signal: this.controller.signal };

    // Arquivo diferente do já processado: começa do zero. (`keepJob` = o pedido é para
    // refazer documentos a partir da transcrição em memória, qualquer que seja o arquivo
    // selecionado no momento.)
    if (!keepJob && file && this.job.fileKey !== fileKeyOf(file)) {
      this.reset();
      this.job.fileKey = fileKeyOf(file);
      this.job.fileName = file.name;
    }

    let current = null;
    try {
      let completedWeight = 0;
      for (const step of STEPS) {
        current = step;
        this.stepBase = completedWeight;
        this.stepWeight = step.weight;

        if (only && !only.includes(step.id)) {
          this.emit({ type: 'step', id: step.id, status: 'kept' });
        } else {
          this.emit({ type: 'step', id: step.id, status: 'active', detail: '' });
          this.progress(0, `${step.label}…`);
          const outcome = await this[`step_${step.id}`](context);
          this.emit({ type: 'step', id: step.id, status: outcome?.skipped ? 'skipped' : 'done', detail: outcome?.detail ?? '' });
        }
        completedWeight += step.weight;
        this.emit({ type: 'progress', ratio: completedWeight / 100 });
      }
      return { ok: true, results: this.snapshot() };
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code !== 'CANCELED') this.emit({ type: 'step', id: current?.id, status: 'error', detail: '' });
      else this.emit({ type: 'step', id: current?.id, status: 'pending', detail: 'Interrompido' });
      return { ok: false, error: appError, stepId: current?.id };
    } finally {
      this.running = false;
      this.controller = null;
      this.extractor.dispose();
    }
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      console.error('Falha ao atualizar a interface:', error);
    }
  }

  progress(ratioInStep, message) {
    const ratio = (this.stepBase + this.stepWeight * Math.min(1, Math.max(0, ratioInStep ?? 0))) / 100;
    this.emit({ type: 'progress', ratio, message });
  }

  detail(stepId, text) {
    this.emit({ type: 'step', id: stepId, status: 'active', detail: text });
  }

  warn(step, code, message) {
    if (this.job.warnings.some((warning) => warning.code === code && warning.message === message)) return;
    this.job.warnings.push({ step, code, message });
    this.emit({ type: 'warning', code, message });
  }

  /** Opções comuns das chamadas ao servidor: cancelamento, espera visível e pedido de senha. */
  callOptions(stepId, signal) {
    return {
      signal,
      onAuthRequired: (code) => this.requestPassword(code),
      onWait: (wait) => {
        if (!wait) return this.emit({ type: 'wait', wait: null });
        const text =
          wait.reason === 'rate_limit'
            ? `Limite de uso da IA atingido. Nova tentativa automática em ${wait.secondsLeft}s…`
            : `Falha passageira. Nova tentativa automática em ${wait.secondsLeft}s…`;
        this.detail(stepId, text);
        return this.emit({ type: 'wait', wait, message: text });
      },
    };
  }

  // ------------------------------------------------------------------ etapas
  async step_prepare({ file, signal }) {
    if (this.job.segments) return { detail: 'Transcrição já disponível' };
    if (!file) throw new AppError('INVALID_FILE');

    this.detail('prepare', 'Verificando o servidor de processamento…');
    let info;
    try {
      info = await api.health({ signal });
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'AUTH_REQUIRED' || appError.code === 'AUTH_INVALID') {
        const provided = await this.requestPassword(appError.code);
        if (!provided) throw appError;
        info = await api.health({ signal });
      } else if (appError.code === 'NETWORK_ERROR' && !getSettings().apiBaseUrl && location.hostname.endsWith('github.io')) {
        throw new AppError('BACKEND_NOT_CONFIGURED', { detail: appError.detail });
      } else {
        throw appError;
      }
    }
    // Servidor protegido por senha: confere a senha ANTES do trabalho pesado.
    // (health só valida a senha quando ela é enviada; sem senha guardada, pede agora.)
    for (let attempt = 0; info.requiresPassword && !info.authenticated; attempt += 1) {
      if (attempt >= 3) throw new AppError('AUTH_INVALID');
      const provided = await this.requestPassword(attempt === 0 ? 'AUTH_REQUIRED' : 'AUTH_INVALID');
      if (!provided) throw new AppError('AUTH_REQUIRED');
      try {
        info = await api.health({ signal });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code !== 'AUTH_INVALID' && appError.code !== 'AUTH_REQUIRED') throw appError;
      }
    }
    this.serverInfo = info;
    this.emit({ type: 'server', info });
    if (info.configured === false) throw new AppError('SERVER_NOT_CONFIGURED');

    if (this.job.audio && this.job.pending) return { detail: 'Áudio já extraído' };

    this.detail('prepare', 'Carregando o componente de extração de áudio…');
    await this.extractor.ensureLoaded({
      signal,
      onProgress: (ratio, bytes) => {
        this.progress(ratio, 'Baixando o componente de extração de áudio (somente na primeira vez)…');
        this.detail('prepare', `Baixando componente de áudio: ${(bytes / 1048576).toFixed(1)} MB`);
      },
    });
    return { detail: 'Arquivo e servidor verificados' };
  }

  effectiveChunkSeconds() {
    const settings = getSettings();
    const bytesPerSecond = (settings.audioBitrateKbps * 1000) / 8;
    const serverLimit = Math.min(this.serverInfo?.maxAudioBytes ?? DEFAULT_SERVER_AUDIO_LIMIT, 14 * 1024 * 1024);
    // O último trecho pode ficar até 25% maior que os demais (ver planCuts).
    const maxByServer = Math.floor((serverLimit * 0.95) / bytesPerSecond / 1.25);
    return Math.max(120, Math.min(settings.chunkMinutes * 60, maxByServer));
  }

  async step_extract({ file, signal }) {
    const { job } = this;
    if (job.segments) return { detail: 'Transcrição já disponível' };
    if (job.audio && job.pending) return { detail: `Áudio já extraído (${formatDuration(job.audio.duration)})` };

    const settings = getSettings();
    const result = await this.extractor.extract(file, {
      chunkSeconds: this.effectiveChunkSeconds(),
      bitrateKbps: settings.audioBitrateKbps,
      signal,
      onProgress: (event) => {
        if (event.phase === 'extract') {
          const done = formatClock(event.processedSeconds);
          const text = event.totalSeconds ? `${done} de ${formatClock(event.totalSeconds)} do vídeo` : `${done} processados`;
          this.detail('extract', text);
          this.progress(event.ratio ?? 0.5, 'Extraindo o áudio do vídeo (no seu computador)…');
        } else if (event.phase === 'split') {
          this.detail('extract', 'Dividindo o áudio em trechos nas pausas da fala…');
          this.progress(0.97, 'Dividindo o áudio em trechos…');
        }
      },
    });

    job.audio = { duration: result.duration, meanVolume: result.meanVolume, maxVolume: result.maxVolume };
    job.pending = result.chunks.map(({ start, end, blob }) => ({ start, end, blob }));
    job.done = [];
    job.roster = [];

    if (result.meanVolume !== null && result.meanVolume <= -40) {
      this.warn('extract', 'LOW_VOLUME', 'O volume do áudio é muito baixo. A transcrição pode conter falhas: revise os documentos com atenção redobrada.');
    }
    const totalMb = job.pending.reduce((sum, chunk) => sum + chunk.blob.size, 0) / 1048576;
    return { detail: `${formatDuration(result.duration)} de áudio em ${job.pending.length} trecho(s) · ${totalMb.toFixed(1)} MB a enviar` };
  }

  mergeRoster(speakers) {
    for (const speaker of speakers ?? []) {
      const known = this.job.roster.find((entry) => entry.label === speaker.label);
      if (!known) {
        this.job.roster.push({ ...speaker });
      } else {
        if (!known.description && speaker.description) known.description = speaker.description;
        if (!known.probableName && speaker.probableName) {
          known.probableName = speaker.probableName;
          known.nameEvidence = speaker.nameEvidence;
        }
      }
    }
  }

  async step_transcribe({ meetingInfo, signal }) {
    const { job } = this;
    if (job.segments) return { detail: `${job.segments.length} falas (transcrição reaproveitada)` };
    if (!job.pending) throw new AppError('PROCESSING_ERROR', { detail: 'Áudio não disponível para transcrição.' });

    const total = job.audio.duration || 1;
    const options = this.callOptions('transcribe', signal);

    while (job.pending.length) {
      const chunk = job.pending[0];
      const position = job.done.length + 1;
      const count = job.done.length + job.pending.length;
      const range = `${formatClock(chunk.start)}–${formatClock(chunk.end)}`;
      this.detail('transcribe', `Trecho ${position} de ${count} (${range})`);
      this.progress(chunk.start / total, `Transcrevendo o trecho ${position} de ${count}…`);

      const previous = job.done[job.done.length - 1];
      const meta = {
        chunkIndex: position - 1,
        totalChunks: count,
        startSeconds: chunk.start,
        endSeconds: chunk.end,
        meetingInfo,
        roster: job.roster.map(({ label, description, probableName }) => ({ label, description, probableName })),
        previousTail: (previous?.segments ?? []).slice(-10).map(({ speaker, text }) => ({ speaker, text })),
      };

      let result = null;
      let splitReason = null;
      try {
        result = await api.transcribe(chunk.blob, meta, options);
        if (result.needsSplit) splitReason = result.splitReason;
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === 'AI_BLOCKED') splitReason = 'bloqueio';
        else if (appError.code === 'PAYLOAD_TOO_LARGE') splitReason = 'tamanho';
        else throw appError;
      }

      const length = chunk.end - chunk.start;
      if (splitReason && length > MIN_SPLITTABLE_SECONDS) {
        // A IA não deu conta do trecho inteiro: divide ao meio e tenta cada metade.
        this.detail('transcribe', `Dividindo o trecho ${position} em duas partes para nova tentativa…`);
        const halves = await this.extractor.splitChunk(chunk, { signal });
        job.pending.splice(0, 1, ...halves);
        continue;
      }

      let segments = result?.segments ?? [];
      if (splitReason && !segments.length) {
        segments = [{ start: 0, speaker: 'Sistema', text: '[trecho não transcrito: o serviço de IA não conseguiu processar este intervalo]' }];
        this.warn('transcribe', 'CHUNK_SKIPPED', `O intervalo ${range} não pôde ser transcrito pelo serviço de IA. Confira esse trecho diretamente no vídeo.`);
      } else if (splitReason) {
        this.warn('transcribe', 'CHUNK_PARTIAL', `A transcrição do intervalo ${range} pode estar incompleta. Confira esse trecho no vídeo.`);
      }

      this.mergeRoster(result?.speakers);
      job.done.push({ start: chunk.start, end: chunk.end, quality: result?.audioQuality ?? 'regular', segments });
      job.pending.shift(); // libera o áudio já transcrito
    }

    // Monta a transcrição completa, com horários absolutos e numeração sequencial.
    const segments = [];
    for (const part of job.done) {
      for (const segment of part.segments) {
        if (segment.speaker === 'Sistema' || segment.text) {
          const start = Math.min(part.end, part.start + (Number(segment.start) || 0));
          segments.push({ id: segments.length + 1, start: Math.round(start), speaker: segment.speaker, text: segment.text });
        }
      }
    }
    const spoken = segments.filter((segment) => segment.speaker !== 'Sistema');
    if (!spoken.length) throw new AppError('NO_SPEECH');

    const poor = job.done.filter((part) => part.quality === 'ruim').length;
    if (poor / job.done.length >= 0.4) {
      this.warn('transcribe', 'LOW_QUALITY_AUDIO', 'O áudio tem baixa qualidade em boa parte da gravação. A transcrição pode conter falhas: revise os documentos com atenção redobrada.');
    }

    job.segments = segments;
    job.pending = null;
    const speakers = new Set(spoken.map((segment) => segment.speaker)).size;
    return { detail: `${spoken.length} falas de ${speakers} voz(es) distinta(s)` };
  }

  basePayload(meetingInfo) {
    return { segments: this.job.segments, participants: this.job.participants ?? [], meetingInfo };
  }

  async step_participants({ meetingInfo, signal }) {
    const { job } = this;
    if (job.participants) {
      return { detail: job.participantsEdited ? 'Identificação corrigida pelo usuário' : 'Identificação reaproveitada' };
    }
    const result = await api.task('participants', { segments: job.segments, meetingInfo, roster: job.roster }, this.callOptions('participants', signal));
    job.participants = result.participants;
    job.mentioned = result.mentioned ?? [];
    const named = job.participants.filter((p) => p.name).length;
    return { detail: `${named} de ${job.participants.length} participante(s) identificado(s) pelo nome` };
  }

  async step_analyze({ meetingInfo, signal }) {
    const { job } = this;
    if (job.analysis) return { detail: 'Análise reaproveitada' };
    const result = await api.task('analyze', this.basePayload(meetingInfo), this.callOptions('analyze', signal));
    job.analysis = result.analysis;
    const topics = job.analysis.pauta?.length ?? 0;
    const processes = job.analysis.processos?.length ?? 0;
    return { detail: `${topics} bloco(s) de pauta · ${processes} processo(s)` };
  }

  async step_deliberations({ meetingInfo, signal }) {
    const { job } = this;
    if (job.items) return { detail: 'Classificação reaproveitada' };
    const result = await api.task('deliberations', { ...this.basePayload(meetingInfo), analysis: job.analysis }, this.callOptions('deliberations', signal));
    job.items = result.items;
    job.itemsSummary = result.summary;
    const s = result.summary;
    const downgraded = s.downgraded ? ` · ${s.downgraded} sem aprovação comprovada (tratada(s) como proposta)` : '';
    return { detail: `${s.deliberations} deliberação(ões) · ${s.proposals} proposta(s) · ${s.actions} encaminhamento(s)${downgraded}` };
  }

  async step_ata({ meetingInfo, signal, extraInstructions }) {
    const { job } = this;
    if (job.ata) return { detail: 'Ata mantida' };
    const result = await api.task(
      'ata',
      { ...this.basePayload(meetingInfo), mentioned: job.mentioned, analysis: job.analysis, items: job.items, extraInstructions: extraInstructions?.ata ?? '' },
      this.callOptions('ata', signal),
    );
    job.ata = { text: result.text };
    if (result.truncated) this.warn('ata', 'ATA_TRUNCATED', 'A Ata atingiu o tamanho máximo de resposta da IA e pode estar incompleta no final.');
    return { detail: `${result.text.split(/\s+/).length} palavras` };
  }

  async step_momento_identify({ meetingInfo, scopeMode, signal }) {
    const { job } = this;
    if (job.momento) return { detail: 'Momento Aberto mantido' };
    if (job.scope) return { detail: 'Período reaproveitado' };
    if (scopeMode === 'all') {
      job.scope = { mode: 'reuniao_inteira', chosenByUser: true };
      return { skipped: true, detail: 'Reunião inteira (opção do usuário)' };
    }
    const result = await api.task('momento_identify', this.basePayload(meetingInfo), this.callOptions('momento_identify', signal));
    job.locate = result;
    if (result.found) {
      job.scope = { mode: 'trecho', from: result.from, to: result.to };
      const first = job.segments.find((segment) => segment.id === result.from);
      const last = job.segments.find((segment) => segment.id === result.to);
      return { detail: `Localizado entre ${formatClock(first?.start)} e ${formatClock(last?.start)} · ${result.speakers.length} manifestante(s)` };
    }
    job.scope = { mode: 'reuniao_inteira', chosenByUser: false };
    return { detail: 'Período formal não localizado — será considerada a reunião inteira' };
  }

  async step_momento({ meetingInfo, signal, extraInstructions }) {
    const { job } = this;
    if (job.momento) return { detail: 'Momento Aberto mantido' };
    const result = await api.task(
      'momento',
      { ...this.basePayload(meetingInfo), analysis: job.analysis, scope: job.scope, extraInstructions: extraInstructions?.momento ?? '' },
      this.callOptions('momento', signal),
    );
    job.momento = { text: result.text, formatProblems: result.formatProblems, retried: result.retried };
    return { detail: result.retried ? 'Refeito automaticamente para cumprir o padrão narrativo' : `${result.text.split(/\s+/).length} palavras` };
  }

  async step_finalize({ meetingInfo, signal }) {
    const { job } = this;
    const documents = {};
    if (job.ata && !job.review.ata) documents.ata = job.ata.text;
    if (job.momento && !job.review.momento) documents.momento = job.momento.text;

    if (Object.keys(documents).length) {
      this.detail('finalize', 'Revisão automática de fidelidade (nomes, datas, números, deliberações)…');
      const payload = { ...this.basePayload(meetingInfo), mentioned: job.mentioned, items: job.items ?? [], documents };
      let result;
      try {
        result = await api.task('review', payload, this.callOptions('finalize', signal));
      } catch (error) {
        const appError = toAppError(error);
        if (['CANCELED', 'AUTH_REQUIRED', 'AUTH_INVALID', 'NETWORK_ERROR'].includes(appError.code)) throw appError;
        // A revisão por IA falhou: mantém ao menos as conferências determinísticas.
        result = await api.task('review', { ...payload, aiReview: false }, this.callOptions('finalize', signal));
        this.warn('finalize', 'AI_REVIEW_SKIPPED', 'A revisão por IA não pôde ser concluída agora; foram feitas as conferências automáticas de números, nomes e formato.');
      }
      job.review.aiReviewed = result.aiReviewed;
      for (const kind of ['ata', 'momento']) {
        if (!result[kind]) continue;
        job[kind].text = result[kind].text;
        job.review[kind] = { applied: result[kind].applied, pending: result[kind].pending, alerts: result[kind].alerts, aiReviewed: result.aiReviewed };
      }
    }

    this.detail('finalize', 'Liberando a memória usada no processamento…');
    this.extractor.dispose();
    const fixes = (job.review.ata?.applied.length ?? 0) + (job.review.momento?.applied.length ?? 0);
    return { detail: fixes ? `${fixes} correção(ões) de fidelidade aplicada(s)` : 'Revisão concluída' };
  }
}
