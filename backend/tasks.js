/**
 * Tarefas de IA executadas pelo backend.
 *
 * Cada tarefa: (1) valida a entrada, (2) monta o prompt, (3) chama o provedor,
 * (4) valida/normaliza a resposta e (5) aplica as verificações determinísticas
 * de fidelidade. Nenhum conteúdo da reunião é gravado em disco ou em log.
 */

import { Errors } from './errors.js';
import { asArray, asInt, asString, parseModelJson } from './json-utils.js';
import {
  analysisPrompt,
  ataPrompt,
  deliberationsPrompt,
  meetingInfoBlock,
  momentoIdentifyPrompt,
  momentoPrompt,
  participantsPrompt,
  reviewPrompt,
  transcriptionPrompt,
} from './prompts.js';
import {
  applyReviewFixes,
  checkNames,
  checkNumbers,
  countDeliberationLines,
  detailRatio,
  normalizeReviewIssues,
  sanitizeDocumentText,
  validateMomentoFormat,
  verifyItems,
} from './quality.js';
import {
  analysisSchema,
  deliberationsSchema,
  momentoIdentifySchema,
  participantsSchema,
  reviewSchema,
  transcriptionSchema,
} from './schemas.js';
import {
  countWords,
  formatTime,
  formatTranscript,
  normalizeParticipants,
  normalizeSegments,
  parseTimestamp,
  plainTranscriptText,
} from './transcript.js';

// ---------------------------------------------------------------------------
// Entrada comum
// ---------------------------------------------------------------------------

export function normalizeMeetingInfo(input) {
  const info = input && typeof input === 'object' ? input : {};
  return {
    number: asString(info.number, 40),
    type: asString(info.type, 120),
    body: asString(info.body, 200),
    date: asString(info.date, 40),
    location: asString(info.location, 300),
    president: asString(info.president, 160),
    participants: asString(info.participants, 4000),
  };
}

function parseJsonOrThrow(result) {
  try {
    return parseModelJson(result.text);
  } catch {
    throw Errors.aiBadResponse();
  }
}

// ---------------------------------------------------------------------------
// Transcrição de um trecho de áudio
// ---------------------------------------------------------------------------

/**
 * Detecta o defeito clássico de modelos de fala: repetir a mesma expressão
 * indefinidamente ("muito obrigado muito obrigado muito obrigado ...").
 * Procura repetições periódicas (período de 1 a 12 palavras) longas demais
 * para serem fala humana.
 */
export function hasRepetitionLoop(text) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 40) return false;
  for (let period = 1; period <= 12; period += 1) {
    const threshold = Math.max(30, period * 10);
    let run = 0;
    for (let i = period; i < words.length; i += 1) {
      run = words[i] === words[i - period] ? run + 1 : 0;
      if (run >= threshold) return true;
    }
  }
  return words.length > 400 && new Set(words).size / words.length < 0.08;
}

export function normalizeTranscriptionMeta(input) {
  const meta = input && typeof input === 'object' ? input : {};
  const startSeconds = Math.max(0, Number(meta.startSeconds) || 0);
  const endSeconds = Math.max(startSeconds, Number(meta.endSeconds) || startSeconds);
  return {
    chunkIndex: Math.max(0, asInt(meta.chunkIndex, 0)),
    totalChunks: Math.max(1, asInt(meta.totalChunks, 1)),
    startSeconds,
    endSeconds,
    startLabel: formatTime(startSeconds),
    meetingInfo: normalizeMeetingInfo(meta.meetingInfo),
    roster: asArray(meta.roster)
      .slice(0, 40)
      .map((speaker) => ({
        label: asString(speaker?.label, 80),
        description: asString(speaker?.description, 300),
        probableName: asString(speaker?.probableName, 160),
      }))
      .filter((speaker) => speaker.label),
    previousTail: asArray(meta.previousTail)
      .slice(-12)
      .map((segment) => ({ speaker: asString(segment?.speaker, 80), text: asString(segment?.text, 600) }))
      .filter((segment) => segment.text),
  };
}

export async function runTranscription({ provider, audio, meta: rawMeta }) {
  const meta = normalizeTranscriptionMeta(rawMeta);
  const { system, user } = transcriptionPrompt({ meta });
  const result = await provider.transcribe({
    audio,
    system,
    user,
    schema: transcriptionSchema,
    context: { meta },
  });

  let parsed;
  try {
    parsed = parseModelJson(result.text);
  } catch {
    if (result.truncated || result.partiallyBlocked) {
      return emptyTranscription(result, 'saida_truncada');
    }
    throw Errors.aiBadResponse();
  }

  const duration = Math.max(1, meta.endSeconds - meta.startSeconds);
  let last = 0;
  let degenerate = false;
  const segments = [];
  for (const raw of asArray(parsed.value?.segmentos)) {
    const text = asString(raw?.texto, 8000).replace(/\s+/g, ' ');
    if (!text) continue;
    if (hasRepetitionLoop(text)) {
      degenerate = true;
      continue;
    }
    let start = parseTimestamp(raw?.inicio);
    if (start === null || start < last) start = last; // mantém a ordem cronológica
    start = Math.min(start, duration);
    last = start;
    segments.push({
      start,
      speaker: asString(raw?.falante, 80).replace(/\s+/g, ' ') || 'Falante não identificado',
      text,
    });
  }

  const speakers = asArray(parsed.value?.falantes)
    .map((raw) => ({
      label: asString(raw?.rotulo, 80).replace(/\s+/g, ' '),
      description: asString(raw?.descricao, 300),
      probableName: asString(raw?.nome_provavel, 160),
      nameEvidence: asString(raw?.evidencia_nome, 300),
    }))
    .filter((speaker) => speaker.label);

  const quality = ['boa', 'regular', 'ruim', 'sem_fala'].includes(parsed.value?.qualidade_audio)
    ? parsed.value.qualidade_audio
    : 'regular';

  const needsSplit = Boolean(result.truncated || result.partiallyBlocked || parsed.repaired || degenerate);
  return {
    segments,
    speakers,
    audioQuality: quality,
    notes: asString(parsed.value?.observacoes, 500),
    needsSplit,
    splitReason: needsSplit
      ? degenerate
        ? 'repeticao_detectada'
        : result.partiallyBlocked
          ? 'bloqueio_parcial'
          : 'saida_truncada'
      : null,
    model: result.model,
    usage: result.usage,
  };
}

function emptyTranscription(result, reason) {
  return {
    segments: [],
    speakers: [],
    audioQuality: 'regular',
    notes: '',
    needsSplit: true,
    splitReason: reason,
    model: result.model,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Tarefas de texto
// ---------------------------------------------------------------------------

function commonInput(payload) {
  const segments = normalizeSegments(payload?.segments);
  const participants = normalizeParticipants(payload?.participants);
  const meetingInfo = normalizeMeetingInfo(payload?.meetingInfo);
  return { segments, participants, meetingInfo };
}

async function taskParticipants({ provider, payload }) {
  const segments = normalizeSegments(payload?.segments);
  const meetingInfo = normalizeMeetingInfo(payload?.meetingInfo);
  const roster = asArray(payload?.roster)
    .slice(0, 60)
    .map((speaker) => ({
      label: asString(speaker?.label, 80),
      description: asString(speaker?.description, 300),
      probableName: asString(speaker?.probableName, 160),
      nameEvidence: asString(speaker?.nameEvidence, 300),
    }));

  const prompt = participantsPrompt({ meetingInfo, roster, transcript: formatTranscript(segments) });
  const result = await provider.generateJson({
    ...prompt,
    schema: participantsSchema,
    purpose: 'participants',
    context: { segments, meetingInfo },
  });
  const { value } = parseJsonOrThrow(result);

  const labels = [...new Set(segments.map((segment) => segment.speaker))];
  const byLabel = new Map();
  for (const raw of asArray(value?.participantes)) {
    const label = asString(raw?.rotulo, 80);
    if (!labels.includes(label) || byLabel.has(label)) continue;
    byLabel.set(label, {
      label,
      name: asString(raw?.nome, 160),
      role: asString(raw?.cargo_funcao, 200),
      institution: asString(raw?.instituicao, 200),
      presides: Boolean(raw?.preside),
      mode: ['presencial', 'remoto'].includes(raw?.modalidade) ? raw.modalidade : 'nao_identificado',
      confidence: ['alta', 'media', 'baixa'].includes(raw?.confianca) ? raw.confianca : 'baixa',
      evidence: asString(raw?.evidencia, 600),
    });
  }
  // Todo rótulo existente precisa de uma entrada (mesmo que "não identificado").
  const participants = labels.map(
    (label) =>
      byLabel.get(label) ?? {
        label,
        name: '',
        role: '',
        institution: '',
        presides: false,
        mode: 'nao_identificado',
        confidence: 'baixa',
        evidence: '',
      },
  );

  const mentioned = asArray(value?.mencionados_sem_fala)
    .slice(0, 60)
    .map((raw) => ({
      name: asString(raw?.nome, 160),
      role: asString(raw?.cargo_funcao, 200),
      mode: ['presencial', 'remoto'].includes(raw?.modalidade) ? raw.modalidade : 'nao_identificado',
      evidence: asString(raw?.evidencia, 400),
    }))
    .filter((person) => person.name);

  return { participants, mentioned, notes: asString(value?.observacoes, 800), model: result.model };
}

async function taskAnalyze({ provider, payload }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const prompt = analysisPrompt({
    meetingInfo,
    participants,
    transcript: formatTranscript(segments, participants),
  });
  const result = await provider.generateJson({
    ...prompt,
    schema: analysisSchema,
    purpose: 'analysis',
    context: { segments, meetingInfo, participants },
  });
  const { value } = parseJsonOrThrow(result);
  if (!value || typeof value !== 'object') throw Errors.aiBadResponse();

  const general = value.informacoes_gerais && typeof value.informacoes_gerais === 'object'
    ? value.informacoes_gerais
    : {};
  const analysis = {
    informacoes_gerais: {
      numero: asString(general.numero, 40),
      tipo: asString(general.tipo, 120),
      orgao: asString(general.orgao, 200),
      data: asString(general.data, 60),
      local: asString(general.local, 300),
      formato: ['presencial', 'remoto', 'hibrido'].includes(general.formato)
        ? general.formato
        : 'nao_identificado',
      proxima_reuniao: asString(general.proxima_reuniao, 200),
    },
    presidencia: {
      identificacao: asString(value.presidencia?.identificacao, 200),
      evidencia: asString(value.presidencia?.evidencia, 600),
    },
    pauta: asArray(value.pauta).slice(0, 80),
    processos: asArray(value.processos).slice(0, 80),
    datas_e_prazos: asArray(value.datas_e_prazos).slice(0, 120),
    instituicoes_citadas: asArray(value.instituicoes_citadas).slice(0, 120).map((v) => asString(v, 200)),
    normas_citadas: asArray(value.normas_citadas).slice(0, 120).map((v) => asString(v, 200)),
    pontos_incertos: asArray(value.pontos_incertos).slice(0, 80),
    houve_encerramento_formal: Boolean(value.houve_encerramento_formal),
  };
  return { analysis, model: result.model };
}

async function taskDeliberations({ provider, payload }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const analysis = payload?.analysis && typeof payload.analysis === 'object' ? payload.analysis : {};
  const prompt = deliberationsPrompt({
    meetingInfo,
    participants,
    analysis,
    transcript: formatTranscript(segments, participants),
  });
  const result = await provider.generateJson({
    ...prompt,
    schema: deliberationsSchema,
    purpose: 'deliberations',
    context: { segments, meetingInfo, participants },
  });
  const { value } = parseJsonOrThrow(result);
  const items = verifyItems(value?.itens, segments);
  return {
    items,
    summary: {
      deliberations: items.filter((item) => item.type === 'deliberacao').length,
      proposals: items.filter((item) => item.type === 'proposta').length,
      actions: items.filter((item) => item.type === 'encaminhamento').length,
      downgraded: items.filter((item) => item.downgraded).length,
    },
    model: result.model,
  };
}

function normalizeItems(input) {
  return asArray(input)
    .slice(0, 300)
    .map((item) => ({
      type: ['proposta', 'deliberacao', 'encaminhamento'].includes(item?.type) ? item.type : 'proposta',
      downgraded: Boolean(item?.downgraded),
      description: asString(item?.description, 1500),
      author: asString(item?.author, 200),
      responsible: asString(item?.responsible, 200),
      deadline: asString(item?.deadline, 200),
      subject: asString(item?.subject, 400),
      segments: asArray(item?.segments).map((id) => asInt(id)).filter((id) => id !== null),
      startSeconds: Number.isFinite(item?.startSeconds) ? item.startSeconds : null,
    }))
    .filter((item) => item.description);
}

async function taskAta({ provider, payload }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const analysis = payload?.analysis && typeof payload.analysis === 'object' ? payload.analysis : {};
  const items = normalizeItems(payload?.items);
  const mentioned = asArray(payload?.mentioned)
    .slice(0, 60)
    .map((person) => ({ name: asString(person?.name, 160), role: asString(person?.role, 200) }));

  const prompt = ataPrompt({
    meetingInfo,
    participants,
    mentioned,
    analysis,
    items,
    transcript: formatTranscript(segments, participants),
    extraInstructions: asString(payload?.extraInstructions, 2000),
  });
  const result = await provider.generateText({
    ...prompt,
    purpose: 'ata',
    context: { segments, meetingInfo, participants, items, analysis },
  });
  const text = sanitizeDocumentText(result.text);
  if (!text) throw Errors.aiBadResponse();
  return { text, truncated: result.truncated, model: result.model };
}

async function taskMomentoIdentify({ provider, payload }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const prompt = momentoIdentifyPrompt({
    meetingInfo,
    participants,
    transcript: formatTranscript(segments, participants),
  });
  const result = await provider.generateJson({
    ...prompt,
    schema: momentoIdentifySchema,
    purpose: 'momento_identify',
    context: { segments, meetingInfo, participants },
  });
  const { value } = parseJsonOrThrow(result);

  const ids = segments.map((segment) => segment.id);
  const minId = Math.min(...ids);
  const maxId = Math.max(...ids);
  let from = asInt(value?.segmento_inicial);
  let to = asInt(value?.segmento_final);
  let found = Boolean(value?.encontrado);
  if (found && (from === null || to === null || from > to || to < minId || from > maxId)) found = false;
  if (found) {
    from = Math.max(minId, from);
    to = Math.min(maxId, to);
  }

  return {
    found,
    from: found ? from : null,
    to: found ? to : null,
    confidence: ['alta', 'media', 'baixa'].includes(value?.confianca) ? value.confianca : 'baixa',
    evidence: asString(value?.evidencia, 600),
    speakers: asArray(value?.manifestantes)
      .slice(0, 60)
      .map((raw) => asString(raw?.identificacao, 200))
      .filter(Boolean),
    note: asString(value?.observacao, 600),
    model: result.model,
  };
}

async function taskMomento({ provider, payload, startedAt, config }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const analysis = payload?.analysis && typeof payload.analysis === 'object' ? payload.analysis : {};
  const extraInstructions = asString(payload?.extraInstructions, 2000);

  const ids = segments.map((segment) => segment.id);
  const minId = Math.min(...ids);
  const maxId = Math.max(...ids);
  const requestedFrom = asInt(payload?.scope?.from);
  const requestedTo = asInt(payload?.scope?.to);
  const useRange =
    payload?.scope?.mode === 'trecho' &&
    requestedFrom !== null &&
    requestedTo !== null &&
    requestedFrom <= requestedTo;
  const scope = useRange
    ? { mode: 'trecho', from: Math.max(minId, requestedFrom), to: Math.min(maxId, requestedTo) }
    : { mode: 'reuniao_inteira' };

  const margin = 3;
  const scopedSegments = useRange
    ? segments.filter((s) => s.id >= scope.from - margin && s.id <= scope.to + margin)
    : segments;
  const coreSegments = useRange
    ? segments.filter((s) => s.id >= scope.from && s.id <= scope.to)
    : segments;
  const transcript = formatTranscript(scopedSegments, participants);
  const sourceWords = countWords(plainTranscriptText(coreSegments));

  const generateOnce = async (corrective) => {
    const prompt = momentoPrompt({
      meetingInfo,
      participants,
      analysis,
      scope,
      transcript,
      extraInstructions,
      corrective,
    });
    const result = await provider.generateText({
      ...prompt,
      purpose: 'momento',
      context: { segments: coreSegments, meetingInfo, participants, corrective, scope },
    });
    const text = sanitizeDocumentText(result.text);
    if (!text) throw Errors.aiBadResponse();
    return { text, model: result.model };
  };

  const assess = (text) => {
    const problems = validateMomentoFormat(text);
    const ratio = detailRatio(text, sourceWords);
    // Relato com menos de 6% do tamanho da fala original é resumo curto demais
    // (o modelo de referência conserva cerca de 20% a 25%).
    if (sourceWords > 400 && scope.mode === 'trecho' && ratio < 0.06) {
      problems.push(
        'O relato ficou excessivamente curto em relação às falas. Preserve os argumentos, fatos, pedidos e preocupações de cada manifestação (em geral, de quatro a dez frases por manifestação).',
      );
    }
    return { problems, ratio };
  };

  let attempt = await generateOnce('');
  let assessment = assess(attempt.text);
  let retried = false;

  const elapsed = Date.now() - startedAt;
  const canRetry = elapsed < config.requestBudgetMs * 0.5;
  if (assessment.problems.length && canRetry) {
    retried = true;
    const corrected = await generateOnce(assessment.problems.map((p) => `- ${p}`).join('\n'));
    const correctedAssessment = assess(corrected.text);
    if (correctedAssessment.problems.length <= assessment.problems.length) {
      attempt = corrected;
      assessment = correctedAssessment;
    }
  }

  return {
    text: attempt.text,
    scope,
    formatProblems: assessment.problems,
    detailRatio: Number(assessment.ratio.toFixed(3)),
    retried,
    model: attempt.model,
  };
}

// ---------------------------------------------------------------------------
// Revisão final (IA + verificações determinísticas)
// ---------------------------------------------------------------------------

function deterministicAlerts({ kind, text, sources, items }) {
  const alerts = [];

  const numbers = checkNumbers(text, sources);
  if (numbers.length) {
    alerts.push({
      code: 'NUMEROS_NAO_LOCALIZADOS',
      message:
        'Números presentes no documento que não foram localizados na transcrição nem nos dados informados. Confira-os no vídeo:',
      values: numbers,
    });
  }

  const names = checkNames(text, sources);
  if (names.length) {
    alerts.push({
      code: 'NOMES_NAO_LOCALIZADOS',
      message:
        'Nomes ou termos com inicial maiúscula que não foram localizados na transcrição nem nos dados informados. Confira a grafia e a procedência:',
      values: names,
    });
  }

  if (kind === 'ata') {
    const confirmed = items.filter((item) => item.type === 'deliberacao').length;
    const written = countDeliberationLines(text);
    if (written > confirmed) {
      alerts.push({
        code: 'DELIBERACOES_EXCEDENTES',
        message: `A Ata registra ${written} "Deliberação:", mas somente ${confirmed} deliberação(ões) tiveram a aprovação confirmada na transcrição. Revise os registros de deliberação.`,
        values: [],
      });
    }
    for (const item of items.filter((entry) => entry.downgraded)) {
      const when = Number.isFinite(item.startSeconds) ? ` (por volta de ${formatTime(item.startSeconds)})` : '';
      alerts.push({
        code: 'DELIBERACAO_NAO_CONFIRMADA',
        message: `Possível deliberação sem aprovação confirmada na transcrição — foi tratada como proposta${when}: ${item.description}`,
        values: [],
      });
    }
  }

  if (kind === 'momento') {
    for (const problem of validateMomentoFormat(text)) {
      alerts.push({ code: 'FORMATO_MOMENTO_ABERTO', message: problem, values: [] });
    }
  }

  if (/\[informação não identificada no áudio\]|\[inaudível\]|\[\?\]/i.test(text)) {
    alerts.push({
      code: 'TRECHOS_INCERTOS',
      message:
        'O documento contém marcações de informação não identificada no áudio. Localize-as (estão destacadas na visualização) e complete-as manualmente, se possível.',
      values: [],
    });
  }
  return alerts;
}

async function taskReview({ provider, payload }) {
  const { segments, participants, meetingInfo } = commonInput(payload);
  const items = normalizeItems(payload?.items);
  const documents = {
    ata: asString(payload?.documents?.ata, 400000),
    momento: asString(payload?.documents?.momento, 400000),
  };
  if (!documents.ata && !documents.momento) throw Errors.badRequest('Nenhum documento para revisar.');

  let issues = [];
  let aiReviewed = false;
  if (payload?.aiReview !== false) {
    const prompt = reviewPrompt({
      meetingInfo,
      participants,
      items,
      documents,
      transcript: formatTranscript(segments, participants),
    });
    const result = await provider.generateJson({
      ...prompt,
      schema: reviewSchema,
      purpose: 'review',
      context: { segments, meetingInfo, documents },
    });
    const { value } = parseJsonOrThrow(result);
    issues = normalizeReviewIssues(value?.problemas);
    aiReviewed = true;
  }

  const sources = [
    plainTranscriptText(segments),
    meetingInfoBlock(meetingInfo),
    participants.map((p) => `${p.name} ${p.role} ${p.institution}`).join('\n'),
    asArray(payload?.mentioned).map((m) => `${asString(m?.name, 160)} ${asString(m?.role, 200)}`).join('\n'),
  ].join('\n');

  const output = { aiReviewed };
  for (const kind of ['ata', 'momento']) {
    if (!documents[kind]) continue;
    const fixes = applyReviewFixes(
      documents[kind],
      issues.filter((issue) => issue.document === kind),
    );
    output[kind] = {
      text: fixes.text,
      applied: fixes.applied,
      pending: fixes.pending,
      alerts: deterministicAlerts({ kind, text: fixes.text, sources, items }),
    };
  }
  return output;
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

const TASKS = {
  participants: taskParticipants,
  analyze: taskAnalyze,
  deliberations: taskDeliberations,
  ata: taskAta,
  momento_identify: taskMomentoIdentify,
  momento: taskMomento,
  review: taskReview,
};

export const TASK_NAMES = Object.keys(TASKS);

export async function runTask({ provider, config, task, payload, startedAt = Date.now() }) {
  const handler = TASKS[task];
  if (!handler) throw Errors.badRequest(`Tarefa desconhecida: ${asString(task, 40)}`);
  return handler({ provider, config, payload, startedAt });
}
