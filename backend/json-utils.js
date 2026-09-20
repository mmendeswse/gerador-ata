/**
 * Leitura tolerante de JSON produzido por modelos de linguagem.
 *
 * Mesmo com "modo JSON", um modelo pode envolver a resposta em cercas de
 * código, acrescentar texto antes/depois ou ter a saída cortada por limite de
 * tokens. Estas funções recuperam o máximo possível SEM inventar conteúdo.
 */

/** Remove cercas ```json ... ``` e espaços. */
export function stripCodeFences(text) {
  let out = String(text ?? '').trim();
  const fenced = out.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) out = fenced[1].trim();
  return out;
}

/** Devolve o trecho entre o primeiro "{" ou "[" e o fechamento correspondente (se houver). */
function sliceFromFirstBracket(text) {
  const start = text.search(/[{[]/);
  return start === -1 ? text : text.slice(start);
}

/**
 * Percorre o texto a partir do primeiro "{" ou "[".
 * - Se encontrar o fechamento correspondente, devolve o JSON completo
 *   (ignorando qualquer texto depois dele): { json, truncated: false }.
 * - Se o texto acabar antes (saída cortada), descarta o último elemento
 *   incompleto e fecha colchetes/chaves pendentes: { json, truncated: true }.
 * - Devolve null quando nada pode ser aproveitado.
 */
export function extractJson(text) {
  const source = sliceFromFirstBracket(stripCodeFences(text));
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafeIndex = -1; // posição logo após o último valor composto completo
  let lastSafeStack = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      lastSafeIndex = i + 1;
      lastSafeStack = [...stack];
      if (stack.length === 0) return { json: source.slice(0, i + 1), truncated: false };
    }
  }

  if (lastSafeIndex === -1 || !lastSafeStack) return null;
  let repaired = source.slice(0, lastSafeIndex).replace(/,\s*$/, '');
  for (let i = lastSafeStack.length - 1; i >= 0; i -= 1) {
    repaired += lastSafeStack[i] === '{' ? '}' : ']';
  }
  return { json: repaired, truncated: true };
}

/**
 * @returns {{ value: any, repaired: boolean }} `repaired` = a saída estava cortada e foi fechada.
 * @throws {SyntaxError} quando nada pode ser aproveitado.
 */
export function parseModelJson(text) {
  const cleaned = stripCodeFences(text);
  try {
    return { value: JSON.parse(cleaned), repaired: false };
  } catch {
    /* tenta extrair abaixo */
  }

  const extracted = extractJson(cleaned);
  if (extracted) {
    try {
      return { value: JSON.parse(extracted.json), repaired: extracted.truncated };
    } catch {
      /* continua */
    }
  }
  throw new SyntaxError('Resposta do modelo não contém JSON aproveitável.');
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asString(value, maxLength = 20000) {
  if (value === null || value === undefined) return '';
  const out = typeof value === 'string' ? value : String(value);
  return out.trim().slice(0, maxLength);
}

export function asInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
