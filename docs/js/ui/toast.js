/** Avisos rápidos no canto da tela (ex.: "Texto copiado com sucesso."). */

import { $, el } from '../lib/dom.js';

const MAX_VISIBLE = 3;

export function toast(message, { type = 'ok', timeout = 3200 } = {}) {
  const region = $('#toast-region');
  const node = el('div', { class: `toast${type === 'error' ? ' is-error' : type === 'warn' ? ' is-warn' : ''}` }, message);
  region.append(node);
  while (region.children.length > MAX_VISIBLE) region.firstElementChild.remove();
  setTimeout(() => node.remove(), timeout);
}
