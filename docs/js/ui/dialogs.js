/** Diálogos modais (elemento <dialog> nativo). */

import { $, $$ } from '../lib/dom.js';

/**
 * Abre o diálogo e resolve com o valor do botão de envio acionado
 * ("" quando o usuário cancela, fecha com Esc ou clica em [data-close]).
 */
export function openDialog(dialog, { onSubmit } = {}) {
  return new Promise((resolve) => {
    const form = $('form', dialog);

    const handleSubmit = async (event) => {
      event.preventDefault(); // nenhum formulário é enviado a servidor algum
      const value = event.submitter?.value || 'ok';
      if (onSubmit) {
        const accepted = await onSubmit(value);
        if (accepted === false) return; // validação falhou: mantém aberto
      }
      dialog.close(value);
    };
    const handleClose = () => {
      form?.removeEventListener('submit', handleSubmit);
      dialog.removeEventListener('close', handleClose);
      resolve(dialog.returnValue || '');
    };

    dialog.returnValue = '';
    form?.addEventListener('submit', handleSubmit);
    dialog.addEventListener('close', handleClose);
    dialog.showModal();
  });
}

export function initDialogs() {
  for (const dialog of $$('dialog')) {
    for (const button of $$('[data-close]', dialog)) {
      button.addEventListener('click', () => dialog.close(''));
    }
    // Clique fora da caixa fecha o diálogo.
    dialog.addEventListener('mousedown', (event) => {
      if (event.target === dialog) dialog.close('');
    });
  }
}

export async function confirmDialog({ title, message, okLabel = 'Confirmar' }) {
  const dialog = $('#dlg-confirm');
  $('#dlg-confirm-title').textContent = title;
  $('#dlg-confirm-message').textContent = message;
  $('#dlg-confirm-ok').textContent = okLabel;
  return (await openDialog(dialog)) === 'ok';
}
