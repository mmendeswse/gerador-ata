/**
 * Controle de qualidade DETERMINÍSTICO (sem IA).
 *
 * Estas verificações existem porque a prioridade nº 1 do sistema é a
 * fidelidade ao que foi dito. Elas não dependem da "boa vontade" do modelo:
 *
 *  1. verifyItems            — cada deliberação precisa de uma citação literal
 *                              que EXISTA na transcrição; senão, vira proposta.
 *  2. validateMomentoFormat  — o Momento Aberto nunca pode sair como roteiro.
 *  3. checkNumbers/checkNames— números e nomes dos documentos são conferidos
 *                              contra a transcrição e os dados do usuário.
 *  4. checkDeliberationCount — a Ata não pode ter mais "Deliberação:" do que
 *                              deliberações confirmadas.
 *  5. applyReviewFixes       — aplica, de forma rastreável, as correções
 *                              apontadas pela revisão de fidelidade.
 */

import { asArray, asInt, asString } from './json-utils.js';
import { countWords, normalizeForMatch } from './transcript.js';

// ---------------------------------------------------------------------------
// Limpeza do texto gerado
// ---------------------------------------------------------------------------

/** Remove Markdown e normaliza espaços/linhas, sem alterar o conteúdo. */
export function sanitizeDocumentText(text) {
  let out = String(text ?? '').replace(/\r\n?/g, '\n');

  // Cercas de código envolvendo o documento inteiro.
  const fenced = out.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenced) out = fenced[1];

  out = out
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // títulos Markdown
        .replace(/\*\*(.+?)\*\*/g, '$1') // negrito
        .replace(/__(.+?)__/g, '$1')
        .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2') // itálico
        .replace(/^\s*[-*•]\s+(?=\S)/, '') // marcadores de lista
        .replace(/[ \t]+$/g, ''),
    )
    .join('\n');

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// 1. Conferência das citações literais
// ---------------------------------------------------------------------------

function ngrams(words, size) {
  const grams = [];
  for (let i = 0; i + size <= words.length; i += 1) grams.push(words.slice(i, i + size).join(' '));
  return grams;
}

/**
 * Confere se a citação existe na transcrição.
 * @returns {{ found: boolean, score: number }}
 */
export function verifyQuote(quote, segments, citedIds = []) {
  const normalizedQuote = normalizeForMatch(quote);
  const quoteWords = normalizedQuote ? normalizedQuote.split(' ') : [];
  if (quoteWords.length < 4) return { found: false, score: 0 };

  const fullText = normalizeForMatch(segments.map((s) => s.text).join(' '));
  if (fullText.includes(normalizedQuote)) return { found: true, score: 1 };

  // Correspondência aproximada: o modelo pode ter limpado uma hesitação ou pontuação.
  const size = quoteWords.length >= 8 ? 4 : 3;
  const quoteGrams = ngrams(quoteWords, size);
  if (!quoteGrams.length) return { found: false, score: 0 };

  const score = (text) => {
    const grams = new Set(ngrams(text.split(' '), size));
    let hits = 0;
    for (const gram of quoteGrams) if (grams.has(gram)) hits += 1;
    return hits / quoteGrams.length;
  };

  // Primeiro, na vizinhança dos segmentos citados (mais rigoroso e mais barato).
  const ids = asArray(citedIds).map((id) => asInt(id)).filter((id) => id !== null);
  if (ids.length) {
    const min = Math.min(...ids) - 3;
    const max = Math.max(...ids) + 3;
    const nearby = normalizeForMatch(
      segments.filter((s) => s.id >= min && s.id <= max).map((s) => s.text).join(' '),
    );
    const nearbyScore = score(nearby);
    if (nearbyScore >= 0.6) return { found: true, score: nearbyScore };
  }

  const globalScore = score(fullText);
  return { found: globalScore >= 0.7, score: globalScore };
}

/**
 * Normaliza os itens devolvidos pela IA e rebaixa a "proposta" toda
 * deliberação cuja comprovação literal não foi localizada na transcrição.
 */
export function verifyItems(rawItems, segments) {
  const validIds = new Set(segments.map((s) => s.id));
  const startById = new Map(segments.map((s) => [s.id, s.start]));

  return asArray(rawItems)
    .map((raw) => {
      const declaredType = ['proposta', 'deliberacao', 'encaminhamento'].includes(raw?.tipo)
        ? raw.tipo
        : 'proposta';
      const segmentIds = asArray(raw?.segmentos)
        .map((id) => asInt(id))
        .filter((id) => id !== null && validIds.has(id));
      const quote = asString(raw?.citacao_literal, 1200);
      const check = verifyQuote(quote, segments, segmentIds);

      const downgraded = declaredType === 'deliberacao' && !check.found;
      return {
        type: downgraded ? 'proposta' : declaredType,
        declaredType,
        downgraded,
        verified: check.found,
        matchScore: Number(check.score.toFixed(2)),
        description: asString(raw?.descricao, 1500),
        author: asString(raw?.autor, 200),
        responsible: asString(raw?.responsavel, 200),
        deadline: asString(raw?.prazo, 200),
        subject: asString(raw?.assunto, 400),
        segments: segmentIds,
        startSeconds: segmentIds.length ? startById.get(Math.min(...segmentIds)) ?? null : null,
        quote,
        rationale: asString(raw?.fundamento, 600),
      };
    })
    .filter((item) => item.description);
}

// ---------------------------------------------------------------------------
// 2. Formato do Momento Aberto
// ---------------------------------------------------------------------------

const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'na', 'no']);

/** true quando o prefixo antes dos dois-pontos parece um rótulo de fala ("João Silva", "Dr. Fulano (IDDD)"). */
function looksLikeSpeakerLabel(prefix) {
  const cleaned = prefix.replace(/\([^)]*\)/g, ' ').replace(/[.,]/g, ' ').trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/);
  if (words.length > 9) return false;
  return words.every((word) => PARTICLES.has(word.toLowerCase()) || /^[A-ZÀ-Ý]/.test(word));
}

/**
 * Procura sinais de roteiro/diálogo no Momento Aberto.
 * @returns {string[]} lista de violações (vazia = formato correto)
 */
export function validateMomentoFormat(text) {
  const violations = [];
  const lines = String(text ?? '').split('\n');
  const body = lines.slice(1); // a primeira linha é o cabeçalho

  if (!/^MOMENTO ABERTO\b/i.test((lines[0] ?? '').trim())) {
    violations.push('A primeira linha deve ser o cabeçalho iniciado por "MOMENTO ABERTO –".');
  }

  let scriptLines = 0;
  let bracketLines = 0;
  let bulletLines = 0;
  let tersePresident = 0;

  for (const rawLine of body) {
    const current = rawLine.trim();
    if (!current) continue;

    if (/^\[[^\]]{1,80}\]\s*:?/.test(current) && !/^\[(informação|inaudível)/i.test(current)) {
      bracketLines += 1;
      continue;
    }
    if (/^([-*•–]\s+|\d+[.)]\s+)/.test(current)) {
      bulletLines += 1;
      continue;
    }

    const colon = current.indexOf(':');
    if (colon > 0 && colon <= 90) {
      const prefix = current.slice(0, colon).trim();
      const rest = current.slice(colon + 1).trim();
      if (/^president[ea]$/i.test(prefix)) {
        if (countWords(rest) < 5) tersePresident += 1;
      } else if (looksLikeSpeakerLabel(prefix)) {
        scriptLines += 1;
      }
    }
  }

  if (bracketLines) {
    violations.push(
      `${bracketLines} linha(s) usam identificação entre colchetes (ex.: "[Presidente]"), que é formato de roteiro.`,
    );
  }
  if (scriptLines) {
    violations.push(
      `${scriptLines} parágrafo(s) usam o formato "Nome: fala". Somente a Presidência usa o prefixo "Presidente:"; as demais manifestações devem ser narradas ("[Função], [Nome] relata que...").`,
    );
  }
  if (bulletLines) {
    violations.push(`${bulletLines} linha(s) usam marcadores ou numeração de lista; use apenas texto corrido.`);
  }
  if (tersePresident) {
    violations.push(
      `${tersePresident} registro(s) da Presidência estão telegráficos (ex.: "Presidente: Agradeceu."). Registre o conteúdo da manifestação.`,
    );
  }
  return violations;
}

/** Razão entre o tamanho do relato e o da fonte; usada para detectar resumos curtos demais. */
export function detailRatio(documentText, sourceWordCount) {
  if (!sourceWordCount) return 1;
  const body = String(documentText ?? '').split('\n').slice(1).join('\n');
  return countWords(body) / sourceWordCount;
}

// ---------------------------------------------------------------------------
// 3. Números e nomes
// ---------------------------------------------------------------------------

const UNITS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, meia: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14,
  quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
};
const TENS = {
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80,
  noventa: 90,
};
const HUNDREDS = {
  cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500,
  seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900,
};
const ORDINAL_STEMS = {
  primeir: 1, segund: 2, terceir: 3, quart: 4, quint: 5, sext: 6, setim: 7, oitav: 8, non: 9,
  decim: 10, vigesim: 20, trigesim: 30, quadragesim: 40, quinquagesim: 50, sexagesim: 60,
  septuagesim: 70, setuagesim: 70, octogesim: 80, nonagesim: 90, centesim: 100, ducentesim: 200,
  trecentesim: 300, tricentesim: 300, quadringentesim: 400, quingentesim: 500, sexcentesim: 600,
  seiscentesim: 600, septingentesim: 700, setingentesim: 700, octingentesim: 800,
  nongentesim: 900, noningentesim: 900, milesim: 1000,
};

function cardinalValue(word) {
  if (word in UNITS) return { value: UNITS[word], kind: 'unit' };
  if (word in TENS) return { value: TENS[word], kind: 'ten' };
  if (word in HUNDREDS) return { value: HUNDREDS[word], kind: 'hundred' };
  const feminine = word.replace(/as$/, 'os');
  if (feminine in HUNDREDS) return { value: HUNDREDS[feminine], kind: 'hundred' };
  return null;
}

function ordinalValue(word) {
  const stem = word.replace(/[ao]s?$/, '');
  return stem in ORDINAL_STEMS ? ORDINAL_STEMS[stem] : null;
}

/**
 * Converte números escritos por extenso em algarismos ("vinte e nove" -> 29,
 * "dois mil e vinte e cinco" -> 2025, "nongentésima sexta" -> 906,
 * "um seis quatro um um" -> 16411). Devolve o conjunto de números encontrados.
 */
export function numbersFromWords(text) {
  const words = normalizeForMatch(text).split(' ').filter(Boolean);
  const found = new Set();
  let i = 0;

  while (i < words.length) {
    // Ordinais ("nonagesima segunda")
    if (ordinalValue(words[i]) !== null) {
      let total = 0;
      while (i < words.length && ordinalValue(words[i]) !== null) {
        total += ordinalValue(words[i]);
        i += 1;
      }
      found.add(String(total));
      continue;
    }

    const first = cardinalValue(words[i]);
    if (!first && words[i] !== 'mil') {
      i += 1;
      continue;
    }

    let total = 0;
    let group = 0;
    let lastKind = null;
    const digitRun = [];
    let consumed = false;

    while (i < words.length) {
      const word = words[i];
      if (word === 'e') {
        const next = words[i + 1];
        if (consumed && next && (cardinalValue(next) || next === 'mil')) {
          i += 1;
          continue;
        }
        break;
      }
      if (word === 'mil') {
        total += (group || 1) * 1000;
        group = 0;
        lastKind = 'mil';
        consumed = true;
        digitRun.length = 0;
        i += 1;
        continue;
      }
      const parsed = cardinalValue(word);
      if (!parsed) break;

      // Dígitos ditados um a um ("um seis quatro um um").
      if (parsed.kind === 'unit' && parsed.value < 10 && words[i - 1] !== 'e' && lastKind === 'unit') {
        if (!digitRun.length) digitRun.push(String(group));
        digitRun.push(String(parsed.value));
        group = parsed.value;
        i += 1;
        continue;
      }
      // Sequência sem "e" que não compõe um número ("vinte trinta"): encerra o atual.
      if (
        lastKind &&
        lastKind !== 'mil' &&
        words[i - 1] !== 'e' &&
        !(lastKind === 'hundred' && parsed.kind !== 'hundred') &&
        !(lastKind === 'ten' && parsed.kind === 'unit' && parsed.value < 10)
      ) {
        break;
      }

      group += parsed.value;
      lastKind = parsed.kind;
      consumed = true;
      i += 1;
    }

    if (digitRun.length > 1) found.add(digitRun.join(''));
    if (consumed) found.add(String(total + group));
    if (!consumed) i += 1;
  }
  return found;
}

/** Conjunto de números (somente dígitos) presentes em um texto, em algarismos ou por extenso. */
export function numberSet(text) {
  const set = numbersFromWords(text);
  const matches = String(text ?? '').match(/\d[\d.,/\-–ºª°]*\d|\d/g) ?? [];
  for (const token of matches) {
    const digits = token.replace(/\D/g, '');
    if (digits) set.add(String(Number(digits)));
    for (const group of token.split(/\D+/).filter(Boolean)) set.add(String(Number(group)));
  }
  return set;
}

/** Números do documento que não aparecem nas fontes (transcrição + dados do usuário). */
export function checkNumbers(documentText, sourceText) {
  const sources = numberSet(sourceText);
  const missing = [];
  const seen = new Set();

  const lines = String(documentText ?? '').split('\n');
  for (const rawLine of lines) {
    // Ignora a numeração das seções ("5.", "5.1.") no início da linha.
    const current = rawLine.replace(/^\s*\d+(\.\d+)*\.?\s+/, '');
    const tokens = current.match(/\d[\d.,/\-–]*\d|\d/g) ?? [];
    for (const token of tokens) {
      const cleaned = token.replace(/[.,/\-–]+$/, '');
      const digits = cleaned.replace(/\D/g, '');
      if (!digits) continue;
      const whole = String(Number(digits));
      const groups = cleaned.split(/\D+/).filter(Boolean).map((g) => String(Number(g)));
      const ok = sources.has(whole) || groups.every((g) => sources.has(g));
      if (!ok && !seen.has(cleaned)) {
        seen.add(cleaned);
        missing.push(cleaned);
      }
    }
  }
  return missing.slice(0, 15);
}

const STRUCTURAL_WORDS = new Set(
  [
    'ata', 'reuniao', 'sessao', 'momento', 'aberto', 'data', 'local', 'membros', 'presentes',
    'presencial', 'remoto', 'presidente', 'presidenta', 'presidencia', 'secretaria', 'secretario',
    'deliberacao', 'encaminhamento', 'ordem', 'dia', 'abertura', 'encerramento', 'comunicacoes',
    'assuntos', 'diversos', 'processo', 'relator', 'relatora', 'comissao', 'conselho', 'colegiado',
    'participante', 'representante', 'membro', 'senhor', 'senhora', 'doutor', 'doutora', 'dra',
    'sra', 'ordinaria', 'extraordinaria', 'ele', 'ela', 'nao', 'foi', 'apos', 'alem', 'disso',
    'apesar', 'por', 'fim', 'segundo', 'conforme', 'ainda', 'tambem', 'informacao', 'audio',
    'identificada', 'nomeado', 'interessado', 'interessada', 'agendamento', 'proxima',
  ],
);

/**
 * Palavras com inicial maiúscula no MEIO das frases (tipicamente nomes de
 * pessoas e instituições) que não aparecem nas fontes.
 */
export function checkNames(documentText, sourceText) {
  const sourceWords = new Set(normalizeForMatch(sourceText).split(' '));
  const missing = [];
  const seen = new Set();

  for (const rawLine of String(documentText ?? '').split('\n')) {
    const current = rawLine.trim();
    if (!current) continue;
    const letters = current.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (letters && letters === letters.toUpperCase()) continue; // títulos em maiúsculas

    const tokens = current.split(/\s+/);
    let sentenceStart = true;
    for (const token of tokens) {
      const word = token.replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, '');
      const startsSentence = sentenceStart;
      sentenceStart = /[.!?:]["'”’)\]]*$/.test(token) && !/^(Dr|Dra|Sr|Sra|Exmo|Exma|Art|nº|n)\.$/i.test(token);
      if (startsSentence) continue;
      if (!/^[A-ZÀ-Ý][a-zà-ÿ]{2,}/.test(word)) continue;

      const normalized = normalizeForMatch(word);
      if (!normalized || normalized.includes(' ')) continue;
      if (STRUCTURAL_WORDS.has(normalized) || sourceWords.has(normalized)) continue;
      // Tolerância a plural/gênero: "Defensores" x "defensor".
      const stem = normalized.replace(/(es|s|a|o)$/, '');
      if (stem.length >= 4 && [...sourceWords].some((w) => w.startsWith(stem))) continue;

      if (!seen.has(normalized)) {
        seen.add(normalized);
        missing.push(word);
      }
    }
  }
  return missing.slice(0, 15);
}

// ---------------------------------------------------------------------------
// 4. Contagem de deliberações
// ---------------------------------------------------------------------------

export function countDeliberationLines(ataText) {
  return String(ataText ?? '')
    .split('\n')
    .filter((current) => /^\s*Delibera[cç][aã]o\s*:/i.test(current)).length;
}

// ---------------------------------------------------------------------------
// 5. Aplicação das correções da revisão de fidelidade
// ---------------------------------------------------------------------------

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function tidyAfterEdit(text) {
  return text
    .split('\n')
    .map((current) =>
      current
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([.,;:!?])/g, '$1')
        .replace(/\(\s*\)/g, '')
        .replace(/,\s*\./g, '.')
        .replace(/[ \t]+$/g, ''),
    )
    .filter((current) => !/^\s*(Delibera[cç][aã]o|Presidente)\s*:\s*\.?\s*$/i.test(current))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Aplica ao documento as correções apontadas pela revisão.
 * Só altera o texto quando o trecho é localizado de forma inequívoca
 * (exatamente uma ocorrência) e a gravidade é alta ou média.
 */
export function applyReviewFixes(documentText, issues) {
  let text = String(documentText ?? '');
  const applied = [];
  const pending = [];

  for (const issue of issues) {
    const excerpt = issue.excerpt;
    const occurrences = countOccurrences(text, excerpt);
    const canApply = occurrences === 1 && issue.severity !== 'baixa' && excerpt.length >= 8;
    if (canApply) {
      text = text.replace(excerpt, () => issue.replacement);
      applied.push({ ...issue, applied: true });
    } else {
      pending.push({
        ...issue,
        applied: false,
        reason:
          occurrences === 0
            ? 'trecho não localizado literalmente'
            : occurrences > 1
              ? 'trecho aparece mais de uma vez'
              : 'gravidade baixa — apenas sinalizado',
      });
    }
  }
  return { text: applied.length ? tidyAfterEdit(text) : text, applied, pending };
}

export function normalizeReviewIssues(rawIssues) {
  return asArray(rawIssues)
    .slice(0, 25)
    .map((raw) => ({
      document: raw?.documento === 'momento_aberto' ? 'momento' : 'ata',
      kind: asString(raw?.tipo, 60) || 'sem_respaldo',
      excerpt: asString(raw?.trecho, 800),
      replacement: asString(raw?.correcao, 800),
      explanation: asString(raw?.explicacao, 800),
      severity: ['alta', 'media', 'baixa'].includes(raw?.gravidade) ? raw.gravidade : 'media',
    }))
    .filter((issue) => issue.excerpt);
}
