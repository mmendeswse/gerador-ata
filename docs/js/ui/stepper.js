/** Painel de progresso: barra geral, cronômetro e as 10 etapas. */

import { $, clear, el, show } from '../lib/dom.js';
import { formatElapsed } from '../lib/format.js';
import { STEPS } from '../services/pipeline.js';

const ICONS = { done: '✓', kept: '✓', skipped: '–', error: '!' };

export class Stepper {
  constructor() {
    this.root = $('#progress');
    this.list = $('#steps');
    this.fill = $('#progress-fill');
    this.bar = $('#progress-bar');
    this.message = $('#progress-message');
    this.elapsed = $('#progress-elapsed');
    this.title = $('#progress-title');
    this.timer = null;
    this.startedAt = 0;
    this.nodes = new Map();
    this.build();
  }

  build() {
    clear(this.list);
    STEPS.forEach((step, index) => {
      const icon = el('span', { class: 'step-icon', 'aria-hidden': 'true' }, String(index + 1));
      const label = el('span', { class: 'step-label' }, step.label);
      const detail = el('span', { class: 'step-detail' });
      const item = el('li', { class: 'step' }, icon, el('div', {}, label, detail));
      this.list.append(item);
      this.nodes.set(step.id, { item, icon, detail, number: String(index + 1) });
    });
  }

  start(title = 'Processando a reunião…') {
    show(this.root, true);
    this.root.classList.remove('is-done', 'is-error');
    this.title.textContent = title;
    for (const node of this.nodes.values()) {
      node.item.className = 'step';
      node.icon.textContent = node.number;
      node.detail.textContent = '';
    }
    this.setProgress(0, '');
    this.startedAt = Date.now();
    this.elapsed.textContent = '00:00';
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.elapsed.textContent = formatElapsed((Date.now() - this.startedAt) / 1000);
    }, 1000);
  }

  setStep(id, status, detail) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.item.className = `step is-${status === 'kept' ? 'done' : status}`;
    node.icon.textContent = status === 'active' ? '' : ICONS[status] ?? node.number;
    if (status === 'kept') node.detail.textContent = 'Mantido';
    else if (detail !== undefined) node.detail.textContent = detail;
    if (status === 'active') node.item.setAttribute('aria-current', 'step');
    else node.item.removeAttribute('aria-current');
  }

  setProgress(ratio, message) {
    if (typeof ratio === 'number') {
      const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
      this.fill.style.width = `${percent}%`;
      this.bar.setAttribute('aria-valuenow', String(percent));
      this.percent = percent;
    }
    if (message !== undefined) this.message.textContent = message;
  }

  finish(state, message) {
    clearInterval(this.timer);
    this.timer = null;
    this.root.classList.toggle('is-done', state === 'done');
    this.root.classList.toggle('is-error', state === 'error');
    this.title.textContent =
      state === 'done' ? 'Processamento concluído' : state === 'canceled' ? 'Processamento cancelado' : 'Processamento interrompido';
    if (message !== undefined) this.message.textContent = message;
  }
}
