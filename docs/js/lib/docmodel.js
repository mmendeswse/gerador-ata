/**
 * Interpreta o texto puro de um documento (Ata ou Momento Aberto) como uma
 * sequência de blocos tipados. A mesma estrutura alimenta a visualização na
 * tela e a exportação para DOCX, garantindo formatação idêntica nas duas.
 *
 * Tipos de bloco: title | meta | heading | subheading | deliberation |
 *                 president | note | paragraph
 */

const META_LABEL =
  /^(Data|Local|Hor[áa]rio|Membros Presentes(?:\s*\([^)]*\))?|Membros Ausentes|Presentes|Participantes(?:\s*\([^)]*\))?|Convidados|Aus[êe]ncias(?: Justificadas)?)\s*:\s*/i;
const HEADING = /^\d{1,2}\.\s+(?=\S)[^a-zà-ÿ]+$/; // "5. ORDEM DO DIA" (sem minúsculas)
const SUBHEADING = /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})*\.?\s+\S/; // "5.1. Processo ..."
const DELIBERATION = /^(Delibera[çc][ãa]o|Delibera[çc][õo]es)\s*:\s*/i;
const PRESIDENT = /^(President[ea])\s*:\s*/;
const MARK = /\[[^\]\n]{1,90}\]/g;

/** Divide o texto em trechos comuns e trechos marcados ([informação não identificada no áudio], [?]...). */
export function splitMarks(text) {
  const runs = [];
  let last = 0;
  for (const match of String(text).matchAll(MARK)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), mark: false });
    runs.push({ text: match[0], mark: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), mark: false });
  return runs;
}

export function parseDocument(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let titleDone = false;
  let headerArea = true; // linhas de metadados só valem antes da primeira seção

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!titleDone) {
      titleDone = true;
      const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, '');
      const looksLikeTitle = /^(ATA|MOMENTO ABERTO)\b/i.test(line) || (letters && letters === letters.toUpperCase());
      if (looksLikeTitle) {
        blocks.push({ type: 'title', text: line });
        continue;
      }
    }

    let match;
    if (HEADING.test(line)) {
      headerArea = false;
      blocks.push({ type: 'heading', text: line });
    } else if (SUBHEADING.test(line)) {
      headerArea = false;
      blocks.push({ type: 'subheading', text: line });
    } else if ((match = line.match(DELIBERATION))) {
      blocks.push({ type: 'deliberation', label: `${match[1]}:`, text: line.slice(match[0].length) });
    } else if ((match = line.match(PRESIDENT))) {
      headerArea = false;
      blocks.push({ type: 'president', label: `${match[1]}:`, text: line.slice(match[0].length) });
    } else if (headerArea && (match = line.match(META_LABEL))) {
      blocks.push({ type: 'meta', label: `${match[1]}:`, text: line.slice(match[0].length) });
    } else if (/^\(.+\)$/.test(line) && /MODO DE TESTE/i.test(line)) {
      blocks.push({ type: 'note', text: line });
    } else {
      if (line.length > 200) headerArea = false;
      blocks.push({ type: 'paragraph', text: line });
    }
  }
  return blocks;
}
