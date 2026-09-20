/**
 * Área de resultados: abas, visualização formatada, edição, cópia, downloads,
 * painel de revisão automática, participantes e transcrição.
 *
 * Todo texto produzido pela IA entra na página via textContent (nunca como HTML).
 */

import { $, $$, clear, el, show } from '../lib/dom.js';
import { parseDocument, splitMarks } from '../lib/docmodel.js';
import { buildFileName, formatClock, formatDuration } from '../lib/format.js';
import { buildDocx } from '../services/docx.js';
import { toast } from './toast.js';

const DOC_LABEL = { ata: 'Ata', momento: 'Momento Aberto', transcricao: 'Transcrição' };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Alternativa para navegadores sem permissão de área de transferência.
    const area = el('textarea', { class: 'visually-hidden', value: text, readOnly: true });
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: fileName, class: 'visually-hidden' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function textBlob(text) {
  // BOM (U+FEFF) + CRLF: abre com a acentuação correta também em programas antigos do Windows.
  const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  return new Blob([String.fromCharCode(0xfeff), body], { type: 'text/plain;charset=utf-8' });
}

export function speakerDisplayName(participant, label) {
  if (!participant) return label;
  const { name, role, institution, presides } = participant;
  let base;
  if (name) base = role ? `${name} — ${role}` : name;
  else if (role) base = role;
  else if (institution) base = `Representante — ${institution}`;
  else base = `Participante não identificado (${label})`;
  if (presides && !/presid/i.test(base)) base = `Presidente — ${base}`;
  return base;
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

export class ResultsView {
  /**
   * @param {{
   *   getMeetingInfo: () => object,
   *   onRegenerate: (kind: 'ata'|'momento') => void,
   *   onApplyParticipants: (participants: object[]) => void,
   *   onDocumentEdited: () => void,
   *   onClear: () => void,
   * }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.root = $('#results');
    this.data = null;
    this.texts = { ata: '', momento: '' };
    this.editing = { ata: false, momento: false };
    this.busy = false;

    this.initTabs();
    this.initToolbars();
    this.initEditors();

    $('#toggle-times').addEventListener('change', (event) => {
      $('#transcript-view').classList.toggle('hide-times', !event.target.checked);
    });
    $('#btn-apply-participants').addEventListener('click', () => this.hooks.onApplyParticipants(this.readParticipants()));
    $('#btn-clear').addEventListener('click', () => this.hooks.onClear());
  }

  // ------------------------------------------------------------------- abas
  initTabs() {
    this.tabs = $$('.tab', this.root);
    this.tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => this.activateTab(tab.id));
      tab.addEventListener('keydown', (event) => {
        const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        let target = null;
        if (move) target = this.tabs[(index + move + this.tabs.length) % this.tabs.length];
        else if (event.key === 'Home') target = this.tabs[0];
        else if (event.key === 'End') target = this.tabs[this.tabs.length - 1];
        if (target) {
          event.preventDefault();
          this.activateTab(target.id);
          target.focus();
        }
      });
    });
  }

  activateTab(tabId) {
    for (const tab of this.tabs) {
      const active = tab.id === tabId;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      show($(`#${tab.getAttribute('aria-controls')}`), active);
    }
  }

  // ---------------------------------------------------------------- botões
  initToolbars() {
    this.root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      const { action, doc } = button.dataset;
      if (action === 'copy') this.copy(doc);
      else if (action === 'txt') this.downloadTxt(doc);
      else if (action === 'docx') this.downloadDocx(doc);
      else if (action === 'edit') this.toggleEdit(doc);
      else if (action === 'regenerate') this.hooks.onRegenerate(doc);
    });
  }

  initEditors() {
    for (const kind of ['ata', 'momento']) {
      const editor = $(`#edit-${kind}`);
      editor.addEventListener('input', () => {
        this.texts[kind] = editor.value;
        this.hooks.onDocumentEdited();
      });
      // Duplo clique na visualização entra no modo de edição.
      $(`#view-${kind}`).addEventListener('dblclick', () => {
        if (!this.busy && !this.editing[kind]) this.toggleEdit(kind);
      });
    }
  }

  setBusy(busy) {
    this.busy = busy;
    for (const button of $$('button[data-action="regenerate"]', this.root)) button.disabled = busy;
    $('#btn-apply-participants').disabled = busy || !this.participantsDirty;
    $('#btn-clear').disabled = busy;
  }

  getText(kind) {
    if (kind === 'transcricao') return this.transcriptText();
    return this.texts[kind] ?? '';
  }

  getTexts() {
    return { ...this.texts };
  }

  async copy(kind) {
    const text = this.getText(kind);
    if (!text.trim()) return toast('Não há texto para copiar.', { type: 'warn' });
    const ok = await copyText(text);
    return ok
      ? toast('Texto copiado com sucesso.')
      : toast('Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.', { type: 'error', timeout: 6000 });
  }

  fileInfo() {
    const info = this.hooks.getMeetingInfo();
    const general = this.data?.analysis?.informacoes_gerais ?? {};
    const spokenDate = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(general.data ?? '') ? general.data : '';
    return { number: info.number || general.numero || '', date: info.date || spokenDate };
  }

  downloadTxt(kind) {
    const text = this.getText(kind);
    if (!text.trim()) return toast('Não há texto para baixar.', { type: 'warn' });
    download(textBlob(text), buildFileName(kind, this.fileInfo(), 'txt'));
    return toast('Arquivo TXT gerado.');
  }

  downloadDocx(kind) {
    const text = this.getText(kind);
    if (!text.trim()) return toast('Não há texto para baixar.', { type: 'warn' });
    try {
      const title = text.split('\n').find((line) => line.trim())?.trim() ?? DOC_LABEL[kind];
      download(buildDocx(text, { title }), buildFileName(kind, this.fileInfo(), 'docx'));
      return toast('Arquivo DOCX gerado.');
    } catch (error) {
      console.error(error);
      return toast('Não foi possível gerar o DOCX. Use “Baixar TXT” ou copie o texto.', { type: 'error', timeout: 6000 });
    }
  }

  // ------------------------------------------------------ edição e leitura
  toggleEdit(kind, force) {
    const wasEditing = this.editing[kind];
    const editing = force ?? !wasEditing;
    this.editing[kind] = editing;
    const editor = $(`#edit-${kind}`);
    const view = $(`#view-${kind}`);
    const button = $(`button[data-action="edit"][data-doc="${kind}"]`, this.root);

    if (editing) {
      editor.value = this.texts[kind];
      show(view, false);
      show(editor, true);
      editor.focus();
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
    } else {
      if (wasEditing) this.texts[kind] = editor.value;
      this.renderDocument(kind);
      show(editor, false);
      show(view, true);
    }
    button.textContent = editing ? 'CONCLUIR EDIÇÃO' : 'EDITAR';
    button.setAttribute('aria-pressed', String(editing));
    $(`#hint-${kind}`).textContent = editing
      ? 'Modo de edição: altere o texto livremente. Copiar e baixar usam sempre o texto editado.'
      : 'Clique em EDITAR (ou dê um duplo clique no texto) para corrigir nomes, datas e frases antes de copiar.';
  }

  renderDocument(kind) {
    const view = clear($(`#view-${kind}`));
    const blocks = parseDocument(this.texts[kind]);
    if (!blocks.length) {
      view.append(el('p', { class: 'doc-note' }, 'Documento vazio.'));
      return;
    }
    const classes = {
      title: 'doc-title', meta: 'doc-meta', heading: 'doc-heading', subheading: 'doc-subheading',
      deliberation: 'doc-deliberation', president: 'doc-president', note: 'doc-note', paragraph: '',
    };
    for (const block of blocks) {
      const paragraph = el('p', { class: classes[block.type] ?? '' });
      if (block.label) paragraph.append(el('span', { class: 'label' }, `${block.label} `));
      for (const piece of splitMarks(block.text)) {
        paragraph.append(piece.mark ? el('mark', { title: 'Ponto a conferir no vídeo' }, piece.text) : piece.text);
      }
      view.append(paragraph);
    }
  }

  // ------------------------------------------------------------ revisão
  renderReview(kind) {
    const box = clear($(`#review-${kind}`));
    const review = this.data?.review?.[kind];
    const notes = [];

    if (kind === 'momento' && this.data?.scope) {
      const scope = this.data.scope;
      if (scope.mode === 'reuniao_inteira' && !scope.chosenByUser) {
        notes.push('Não foi identificado um período formal de Momento Aberto nesta gravação. O relato abaixo considera as manifestações de toda a reunião.');
      } else if (scope.mode === 'reuniao_inteira') {
        notes.push('Por opção sua, o relato considera as manifestações de toda a reunião.');
      } else if (this.data.locate?.confidence === 'baixa') {
        notes.push('O período do Momento Aberto foi localizado com baixa confiança. Confira se o início e o fim estão corretos.');
      }
    }
    for (const warning of this.data?.warnings ?? []) notes.push(warning.message);

    const applied = review?.applied ?? [];
    const pending = review?.pending ?? [];
    const alerts = review?.alerts ?? [];
    const attention = pending.length + alerts.length + notes.length;
    if (!review && !notes.length) return show(box, false);

    const clean = attention === 0;
    box.classList.toggle('is-clean', clean);
    const summaryBits = [];
    if (applied.length) summaryBits.push(`${applied.length} correção(ões) de fidelidade aplicada(s)`);
    summaryBits.push(attention ? `${attention} ponto(s) de atenção` : 'nenhum ponto de atenção');
    const summary = el('summary', {}, `Revisão automática: ${summaryBits.join(' · ')}`);
    const body = el('div', { class: 'review-body' });

    if (review && review.aiReviewed === false) {
      body.append(el('p', {}, 'A revisão por IA não pôde ser concluída; foram feitas somente as conferências automáticas.'));
    }
    if (applied.length) {
      body.append(el('h3', {}, 'Correções aplicadas ao texto'));
      body.append(
        el('ul', {}, applied.map((issue) =>
          el('li', {},
            el('span', { class: 'was' }, issue.excerpt),
            ' → ',
            el('span', { class: 'now' }, issue.replacement || '(trecho removido)'),
            el('span', { class: 'why' }, issue.explanation),
          ),
        )),
      );
    }
    if (pending.length) {
      body.append(el('h3', {}, 'Apontamentos da revisão para sua conferência'));
      body.append(
        el('ul', {}, pending.map((issue) =>
          el('li', {},
            el('strong', {}, `“${issue.excerpt}”`),
            el('span', { class: 'why' }, `${issue.explanation}${issue.replacement ? ` Sugestão: ${issue.replacement}` : ''}`),
          ),
        )),
      );
    }
    if (alerts.length || notes.length) {
      body.append(el('h3', {}, 'Pontos de atenção'));
      const list = el('ul');
      for (const alert of alerts) {
        const item = el('li', {}, alert.message);
        if (alert.values?.length) {
          item.append(el('br'), el('span', { class: 'review-values' }, alert.values.map((value) => el('span', {}, value))));
        }
        list.append(item);
      }
      for (const note of notes) list.append(el('li', {}, note));
      body.append(list);
    }
    if (clean && !applied.length) {
      body.append(el('p', {}, 'A revisão automática não encontrou informações sem respaldo na transcrição. Ainda assim, confira o documento antes do uso oficial.'));
    }

    const details = el('details', { open: !clean }, summary, body);
    box.append(details);
    return show(box, true);
  }

  // ------------------------------------------------ participantes e transcrição
  renderParticipants() {
    const body = clear($('#participants-body'));
    const participants = this.data?.participants ?? [];
    $('#participants-count').textContent = String(participants.length);
    this.participantsDirty = false;
    $('#btn-apply-participants').disabled = true;

    const counts = new Map();
    for (const segment of this.data?.segments ?? []) counts.set(segment.speaker, (counts.get(segment.speaker) ?? 0) + 1);

    for (const participant of participants) {
      const markDirty = () => {
        this.participantsDirty = true;
        $('#btn-apply-participants').disabled = this.busy;
      };
      const name = el('input', { type: 'text', value: participant.name, maxLength: 120, placeholder: 'não identificado', 'aria-label': `Nome de ${participant.label}`, oninput: markDirty });
      const role = el('input', { type: 'text', value: participant.role || participant.institution, maxLength: 200, placeholder: 'não identificado', 'aria-label': `Cargo ou função de ${participant.label}`, oninput: markDirty });
      const presides = el('input', { type: 'checkbox', checked: participant.presides, 'aria-label': `${participant.label} preside a reunião`, onchange: markDirty });
      const row = el('tr', { dataset: { label: participant.label } },
        el('td', {}, participant.label, el('br'), el('span', { class: 'field-hint' }, `${counts.get(participant.label) ?? 0} fala(s)`)),
        el('td', {}, name),
        el('td', {}, role),
        el('td', {}, presides),
        el('td', { class: 'evidence' }, el('span', { class: `confidence ${participant.confidence}` }, participant.confidence), participant.evidence || '—'),
      );
      body.append(row);
    }
  }

  readParticipants() {
    const original = new Map((this.data?.participants ?? []).map((p) => [p.label, p]));
    return $$('#participants-body tr').map((row) => {
      const base = original.get(row.dataset.label) ?? {};
      const [name, role] = $$('input[type="text"]', row).map((input) => input.value.trim());
      const changed = name !== (base.name ?? '') || role !== (base.role || base.institution || '');
      return {
        ...base,
        label: row.dataset.label,
        name,
        role,
        institution: changed ? '' : base.institution ?? '',
        presides: $('input[type="checkbox"]', row).checked,
        confidence: changed ? 'alta' : base.confidence ?? 'baixa',
        evidence: changed ? 'Informado pelo usuário.' : base.evidence ?? '',
      };
    });
  }

  renderTranscript() {
    const view = clear($('#transcript-view'));
    const byLabel = new Map((this.data?.participants ?? []).map((p) => [p.label, p]));
    const fragment = document.createDocumentFragment();
    for (const segment of this.data?.segments ?? []) {
      fragment.append(
        el('div', { class: 'segment' },
          el('div', { class: 'segment-time' }, formatClock(segment.start)),
          el('div', {},
            el('div', { class: 'segment-speaker' }, speakerDisplayName(byLabel.get(segment.speaker), segment.speaker)),
            el('div', { class: 'segment-text' }, segment.text),
          ),
        ),
      );
    }
    view.append(fragment);
  }

  transcriptText() {
    const byLabel = new Map((this.data?.participants ?? []).map((p) => [p.label, p]));
    const withTimes = $('#toggle-times').checked;
    return (this.data?.segments ?? [])
      .map((segment) => {
        const who = speakerDisplayName(byLabel.get(segment.speaker), segment.speaker);
        return `${withTimes ? `[${formatClock(segment.start)}] ` : ''}${who}: ${segment.text}`;
      })
      .join('\n\n');
  }

  // ----------------------------------------------------------------- geral
  /**
   * @param {object} data      resultado do pipeline (snapshot)
   * @param {{ keepTexts?: {ata?: string, momento?: string}, focus?: boolean }} [options]
   */
  render(data, { keepTexts = {}, focus = false } = {}) {
    this.data = data;
    for (const kind of ['ata', 'momento']) {
      this.editing[kind] = false; // descarta o modo de edição sem ler o editor antigo
      this.texts[kind] = keepTexts[kind] ?? data[kind]?.text ?? '';
      $(`#edit-${kind}`).value = this.texts[kind];
      this.toggleEdit(kind, false);
      this.renderReview(kind);
    }
    this.renderParticipants();
    this.renderTranscript();

    const bits = [];
    if (data.fileName) bits.push(data.fileName);
    if (data.duration) bits.push(formatDuration(data.duration));
    if (data.segments?.length) bits.push(`${data.segments.length} falas transcritas`);
    $('#results-summary').textContent = bits.join(' · ');

    show(this.root, true);
    if (focus) {
      this.activateTab('tab-ata');
      this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  hide() {
    this.data = null;
    this.texts = { ata: '', momento: '' };
    show(this.root, false);
  }
}
