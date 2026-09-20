/**
 * Estruturas e formatação da transcrição.
 *
 * Segmento: { id: number, start: number (segundos), speaker: string (rótulo), text: string }
 * Participante: { label, name, role, institution, presides, mode, confidence, evidence }
 */

import { Errors } from './errors.js';
import { asArray, asInt, asString } from './json-utils.js';

const MAX_SEGMENTS = 20000;
const MAX_SEGMENT_CHARS = 6000;

export function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const raw = asString(value);
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d:.,]/g, '').replace(',', '.');
  if (!cleaned) return null;
  const parts = cleaned.split(':').map((part) => Number.parseFloat(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.max(0, seconds);
}

export function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Valida os segmentos recebidos do navegador. */
export function normalizeSegments(input) {
  const segments = asArray(input);
  if (!segments.length) throw Errors.badRequest('A transcrição está vazia.');
  if (segments.length > MAX_SEGMENTS) throw Errors.badRequest('A transcrição é grande demais.');

  return segments.map((segment, index) => ({
    id: asInt(segment?.id, index + 1),
    start: Math.max(0, Number(segment?.start) || 0),
    speaker: asString(segment?.speaker, 80) || 'Falante não identificado',
    text: asString(segment?.text, MAX_SEGMENT_CHARS),
  }));
}

export function normalizeParticipants(input) {
  return asArray(input)
    .map((p) => ({
      label: asString(p?.label, 80),
      name: asString(p?.name, 160),
      role: asString(p?.role, 200),
      institution: asString(p?.institution, 200),
      presides: Boolean(p?.presides),
      mode: ['presencial', 'remoto'].includes(p?.mode) ? p.mode : 'nao_identificado',
      confidence: ['alta', 'media', 'baixa'].includes(p?.confidence) ? p.confidence : 'baixa',
      evidence: asString(p?.evidence, 600),
    }))
    .filter((p) => p.label);
}

/**
 * Nome de exibição de um participante, usando sempre a informação mais precisa
 * que pôde ser comprovada (nome > função > instituição > não identificado).
 */
export function displayName(participant, label) {
  if (!participant) return `Participante não identificado (${label})`;
  const { name, role, institution, presides } = participant;
  let base;
  if (name) base = role ? `${name} — ${role}` : name;
  else if (role) base = role;
  else if (institution) base = `Representante — ${institution}`;
  else base = `Participante não identificado (${label})`;

  if (presides && !/presid/i.test(base)) base = `Presidente — ${base}`;
  return base;
}

export function participantIndex(participants) {
  const map = new Map();
  for (const participant of participants) map.set(participant.label, participant);
  return map;
}

/**
 * Transcrição numerada para os prompts:
 *   #12 [00:12:34] Michel — Secretário: texto...
 */
export function formatTranscript(segments, participants = [], { from = null, to = null } = {}) {
  const index = participantIndex(participants);
  const lines = [];
  for (const segment of segments) {
    if (from !== null && segment.id < from) continue;
    if (to !== null && segment.id > to) continue;
    const who = participants.length
      ? displayName(index.get(segment.speaker), segment.speaker)
      : segment.speaker;
    lines.push(`#${segment.id} [${formatTime(segment.start)}] ${who}: ${segment.text}`);
  }
  return lines.join('\n');
}

/** Texto corrido da transcrição (sem rótulos), usado nas verificações determinísticas. */
export function plainTranscriptText(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

/** minúsculas, sem acentos, sem pontuação, espaços simples. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function countWords(value) {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(' ').length : 0;
}
