/**
 * GERADOR DE ATA E MOMENTO ABERTO — ponto de entrada da interface.
 */

import { $, el, show } from './lib/dom.js';
import { describeError } from './lib/errors.js';
import { isValidDateBr, maskDate } from './lib/format.js';
import { api } from './services/api.js';
import { MeetingPipeline } from './services/pipeline.js';
import { getPassword, getSettings, isPasswordRemembered, saveSettings, setPassword } from './settings.js';
import { confirmDialog, initDialogs, openDialog } from './ui/dialogs.js';
import { ResultsView } from './ui/results.js';
import { Stepper } from './ui/stepper.js';
import { toast } from './ui/toast.js';
import { UploadArea } from './ui/upload.js';

const SESSION_KEY = 'gam.sessao';
const FORM_KEY = 'gam.formulario';

const state = {
  file: null,
  serverInfo: null,
  running: false,
  lastRun: null, // parâmetros da última execução (para "Tentar novamente")
  wakeLock: null,
};

// ---------------------------------------------------------------------------
// Armazenamento da sessão (some ao fechar a aba; nada vai para servidor algum)
// ---------------------------------------------------------------------------

function sessionRead(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sessionWrite(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem espaço ou armazenamento bloqueado: os resultados ficam só na memória */
  }
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

const form = $('#info-form');

function getMeetingInfo() {
  // Lê direto dos campos: FormData ignora campos desabilitados (e eles ficam
  // desabilitados durante o processamento).
  const value = (name) => String(form.elements.namedItem(name)?.value ?? '').trim();
  return {
    number: value('number'),
    type: value('type'),
    body: value('body'),
    date: value('date'),
    location: value('location'),
    president: value('president'),
    participants: value('participants'),
  };
}

function getScopeMode() {
  return $('#f-scope').value === 'all' ? 'all' : 'auto';
}

function validateForm() {
  const input = $('#f-date');
  const valid = !input.value || isValidDateBr(input.value);
  input.setAttribute('aria-invalid', String(!valid));
  show($('#f-date-error'), !valid);
  if (!valid) input.focus();
  return valid;
}

function initForm() {
  const saved = sessionRead(FORM_KEY);
  if (saved) {
    for (const [name, value] of Object.entries(saved)) {
      const field = form.elements.namedItem(name);
      if (field && typeof value === 'string') field.value = value;
    }
  }
  $('#f-date').addEventListener('input', (event) => {
    event.target.value = maskDate(event.target.value);
    if (event.target.getAttribute('aria-invalid') === 'true') validateForm();
  });
  $('#f-date').addEventListener('blur', validateForm);
  form.addEventListener('input', () => sessionWrite(FORM_KEY, { ...getMeetingInfo(), scope: $('#f-scope').value }));
  form.addEventListener('submit', (event) => event.preventDefault());
}

function setFormDisabled(disabled) {
  for (const field of form.elements) field.disabled = disabled;
}

// ---------------------------------------------------------------------------
// Avisos fixos no topo
// ---------------------------------------------------------------------------

function setBanner(id, content) {
  const area = $('#banner-area');
  area.querySelector(`[data-banner="${id}"]`)?.remove();
  if (!content) return;
  const banner = el('div', { class: `banner banner-${content.type ?? 'warn'}`, dataset: { banner: id } }, el('p', {}, content.text));
  if (content.action) banner.append(el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: content.action.run }, content.action.label));
  area.append(banner);
}

// ---------------------------------------------------------------------------
// Servidor de processamento
// ---------------------------------------------------------------------------

function applyServerInfo(info) {
  state.serverInfo = info;
  const pill = $('#server-status');
  pill.className = 'status-pill is-ok';
  pill.textContent = `Servidor conectado · ${info.providerLabel}`;
  $('#provider-name').textContent =
    info.provider === 'mock'
      ? 'a um provedor SIMULADO (modo de teste: nenhum serviço externo de IA é usado)'
      : `ao serviço externo de IA (${info.providerLabel})`;
  $('#app-version').textContent = `Versão ${info.version}.`;
  setBanner('server', null);

  if (info.provider === 'mock') {
    setBanner('mock', { type: 'info', text: 'MODO DE TESTE: o servidor está usando o provedor simulado. Os documentos gerados são fictícios e não refletem o vídeo enviado. Configure GEMINI_API_KEY para processar reuniões reais.' });
  } else setBanner('mock', null);

  if (info.configured === false) {
    pill.className = 'status-pill is-warn';
    pill.textContent = 'Servidor sem chave de IA';
    setBanner('server', { type: 'warn', text: 'O servidor respondeu, mas ainda não tem a chave da IA configurada (variável de ambiente GEMINI_API_KEY). Veja o README, seção “Configuração da API”.' });
  }
}

async function checkServer() {
  const pill = $('#server-status');
  pill.className = 'status-pill is-checking';
  pill.textContent = 'Verificando servidor…';
  try {
    applyServerInfo(await api.health());
    return true;
  } catch (error) {
    const { code } = describeError(error);
    if (code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID') {
      // O servidor existe; a senha guardada está errada. Será pedida ao processar.
      pill.className = 'status-pill is-warn';
      pill.textContent = 'Servidor conectado · senha necessária';
      setBanner('server', { type: 'warn', text: 'A senha de acesso guardada neste navegador foi recusada pelo servidor.', action: { label: 'Informar senha', run: () => openSettings() } });
      return true;
    }
    state.serverInfo = null;
    pill.className = 'status-pill is-error';
    pill.textContent = 'Servidor não conectado';
    const base = getSettings().apiBaseUrl;
    setBanner('server', {
      type: 'error',
      text: base
        ? `Não foi possível conectar ao servidor de processamento (${base}). Verifique o endereço, se o servidor está publicado e se esta página está autorizada em ALLOWED_ORIGINS.`
        : 'O servidor de processamento ainda não foi configurado. Esta página (interface) precisa de um servidor para falar com a IA com segurança: informe o endereço em Configurações.',
      action: { label: 'Abrir Configurações', run: () => openSettings() },
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Diálogos: configurações e senha
// ---------------------------------------------------------------------------

async function openSettings() {
  const settings = getSettings();
  $('#s-api').value = settings.apiBaseUrl;
  $('#s-password').value = getPassword();
  $('#s-remember').checked = isPasswordRemembered();
  $('#s-chunk').value = settings.chunkMinutes;
  const status = $('#settings-status');
  status.textContent = '';
  status.className = 'settings-status';

  const apply = () => {
    saveSettings({ apiBaseUrl: $('#s-api').value, chunkMinutes: $('#s-chunk').value });
    setPassword($('#s-password').value, $('#s-remember').checked);
  };

  $('#btn-test-connection').onclick = async () => {
    apply();
    status.className = 'settings-status';
    status.textContent = 'Testando…';
    try {
      const info = await api.health();
      status.className = 'settings-status is-ok';
      const passwordNote = !info.requiresPassword
        ? ''
        : info.authenticated
          ? ' · senha aceita'
          : ' · este servidor exige senha: informe-a no campo acima e teste de novo';
      const keyNote = info.configured === false ? ' · ATENÇÃO: servidor sem chave de IA (GEMINI_API_KEY)' : '';
      status.textContent = `Conexão estabelecida: ${info.providerLabel} (${info.model})${passwordNote}${keyNote}.`;
    } catch (error) {
      const { title, hint } = describeError(error);
      status.className = 'settings-status is-error';
      status.textContent = `${title} ${hint}`;
    }
  };

  const result = await openDialog($('#dlg-settings'), { onSubmit: () => apply() });
  if (result) {
    toast('Configurações salvas.');
    await checkServer();
  }
}

/** Pede a senha ao usuário (chamado pelo pipeline quando o servidor responde 401). */
async function requestPassword(code) {
  $('#password-message').textContent =
    code === 'AUTH_INVALID'
      ? 'A senha informada foi recusada pelo servidor. Digite a senha correta para continuar.'
      : 'Este servidor exige uma senha de acesso para processar reuniões.';
  $('#p-password').value = '';
  $('#p-remember').checked = isPasswordRemembered();
  const result = await openDialog($('#dlg-password'), {
    onSubmit: () => {
      const value = $('#p-password').value;
      if (!value) return false;
      setPassword(value, $('#p-remember').checked);
      return true;
    },
  });
  return Boolean(result);
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const stepper = new Stepper();

const results = new ResultsView({
  getMeetingInfo,
  onRegenerate: (kind) => regenerate(kind),
  onApplyParticipants: (participants) => applyParticipants(participants),
  onDocumentEdited: () => persistSessionSoon(),
  onClear: () => clearResults(),
});

const pipeline = new MeetingPipeline({
  requestPassword,
  onEvent: (event) => {
    if (event.type === 'step') stepper.setStep(event.id, event.status, event.detail);
    else if (event.type === 'progress') {
      stepper.setProgress(event.ratio, event.message);
      if (state.running && typeof stepper.percent === 'number') document.title = `${stepper.percent}% · Gerador de Ata`;
    } else if (event.type === 'wait' && event.message) stepper.setProgress(undefined, event.message);
    else if (event.type === 'server') applyServerInfo(event.info);
    else if (event.type === 'warning') toast(event.message, { type: 'warn', timeout: 9000 });
  },
});

const upload = new UploadArea({
  onChange: (file) => {
    state.file = file;
    hideError();
    updateProcessButton();
  },
  onError: (error) => {
    const { title, hint } = describeError(error);
    toast(`${title} ${hint}`, { type: 'error', timeout: 9000 });
  },
});

function updateProcessButton() {
  const button = $('#btn-process');
  button.disabled = state.running || !state.file;
  button.textContent = state.file && pipeline.hasTranscript(state.file) ? 'PROCESSAR NOVAMENTE' : 'PROCESSAR REUNIÃO';
}

async function acquireWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    state.wakeLock = null; // recurso opcional
  }
}

function setRunning(running) {
  state.running = running;
  show($('#btn-cancel'), running);
  upload.setDisabled(running);
  setFormDisabled(running);
  results.setBusy(running);
  $('#btn-settings').disabled = running;
  updateProcessButton();
  if (running) acquireWakeLock();
  else {
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
    document.title = 'Gerador de Ata e Momento Aberto';
  }
}

function hideError() {
  show($('#error-panel'), false);
}

function showError(error) {
  const { code, title, hint, detail } = describeError(error);
  if (code === 'CANCELED') {
    stepper.finish('canceled', 'Processamento cancelado. O que já foi feito será reaproveitado se você processar novamente.');
    return;
  }
  stepper.finish('error', '');
  $('#error-title').textContent = title;
  $('#error-hint').textContent = hint;
  $('#error-details').textContent = detail ? `[${code}] ${detail}` : `[${code}]`;
  show($('#error-details-wrap'), true);
  show($('#error-panel'), true);
  $('#error-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let persistTimer = null;
/** Durante a digitação, grava no máximo uma vez a cada 0,6 s (a transcrição pode ser grande). */
function persistSessionSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSession, 600);
}

function persistSession() {
  const snapshot = pipeline.snapshot();
  if (!snapshot.segments) return;
  const texts = results.getTexts();
  sessionWrite(SESSION_KEY, { ...snapshot, ata: snapshot.ata && { ...snapshot.ata, text: texts.ata }, momento: snapshot.momento && { ...snapshot.momento, text: texts.momento } });
}

/**
 * Executa o pipeline.
 * @param {{ only?: string[], extraInstructions?: object, title?: string, keep?: 'ata'|'momento' }} options
 */
async function execute(options = {}) {
  if (state.running) return;
  if (!validateForm()) return;
  hideError();

  const keepTexts = {};
  if (options.keep) keepTexts[options.keep] = results.getTexts()[options.keep]; // preserva edições do outro documento

  state.lastRun = options;
  setRunning(true);
  stepper.start(options.title);
  $('#progress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const outcome = await pipeline.run({
    file: state.file,
    meetingInfo: getMeetingInfo(),
    scopeMode: getScopeMode(),
    only: options.only ?? null,
    extraInstructions: options.extraInstructions ?? null,
    keepJob: Boolean(options.keepJob),
  });
  setRunning(false);

  if (outcome.ok) {
    stepper.finish('done', 'Documentos prontos para revisão.');
    results.render(outcome.results, { keepTexts, focus: true });
    persistSession();
    toast('Documentos gerados. Revise antes de utilizar.');
  } else {
    showError(outcome.error);
  }
}

async function onProcessClick() {
  if (!state.file) return;
  if (pipeline.hasTranscript(state.file)) {
    const choice = await openDialog($('#dlg-reprocess'));
    if (choice === 'documents') {
      pipeline.invalidateFrom('participants');
      await execute({ keepJob: true, title: 'Refazendo a análise e os documentos…' });
      return;
    }
    if (choice !== 'everything') return;
    pipeline.reset();
  }
  await execute();
}

async function regenerate(kind) {
  if (state.running || !pipeline.hasTranscript()) return;
  const label = kind === 'ata' ? 'Ata da Reunião' : 'Momento Aberto';
  $('#dlg-regenerate-title').textContent = `Gerar novamente — ${label}`;
  $('#r-instructions').value = '';
  const confirmed = await openDialog($('#dlg-regenerate'));
  if (!confirmed) return;

  const instructions = $('#r-instructions').value.trim();
  const only = pipeline.prepareRegeneration(kind, getScopeMode());
  await execute({
    only,
    keepJob: true,
    extraInstructions: { [kind]: instructions },
    title: `Gerando novamente: ${label}…`,
    keep: kind === 'ata' ? 'momento' : 'ata', // preserva as edições feitas no outro documento
  });
}

async function applyParticipants(participants) {
  if (state.running) return;
  const confirmed = await confirmDialog({
    title: 'Aplicar correções dos participantes',
    message: 'A análise, a Ata e o Momento Aberto serão gerados novamente com a identificação corrigida. A transcrição é reaproveitada. Os textos atuais (incluindo edições) serão substituídos.',
    okLabel: 'Aplicar e gerar novamente',
  });
  if (!confirmed) return;
  pipeline.invalidateFrom('analyze');
  pipeline.setParticipants(participants);
  await execute({ keepJob: true, title: 'Gerando os documentos com a identificação corrigida…' });
}

async function clearResults() {
  const confirmed = await confirmDialog({
    title: 'Limpar resultados',
    message: 'A transcrição e os documentos guardados neste navegador serão apagados. Esta ação não pode ser desfeita.',
    okLabel: 'Limpar',
  });
  if (!confirmed) return;
  pipeline.reset();
  sessionWrite(SESSION_KEY, null);
  results.hide();
  show($('#progress'), false);
  updateProcessButton();
  toast('Resultados apagados deste navegador.');
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

function restoreSession() {
  const saved = sessionRead(SESSION_KEY);
  if (!saved?.segments?.length) return;
  pipeline.restore(saved);
  results.render(pipeline.snapshot());
  setBanner('restored', {
    type: 'info',
    text: 'Os resultados do último processamento desta aba foram recuperados. Eles ficam guardados somente neste navegador, até você fechar a aba ou limpá-los.',
    action: { label: 'Entendi', run: () => setBanner('restored', null) },
  });
}

function init() {
  initDialogs();
  initForm();
  restoreSession();
  updateProcessButton();

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-process').addEventListener('click', () => onProcessClick());
  $('#btn-cancel').addEventListener('click', () => pipeline.cancel());
  $('#btn-retry').addEventListener('click', () => execute(state.lastRun ?? {}));
  $('#btn-restart').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Recomeçar do zero',
      message: 'Tudo o que já foi processado deste vídeo (inclusive trechos já transcritos) será descartado.',
      okLabel: 'Recomeçar',
    });
    if (!confirmed) return;
    pipeline.reset();
    await execute();
  });

  window.addEventListener('pagehide', () => {
    if (persistTimer) persistSession();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.running) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (state.running && document.visibilityState === 'visible' && !state.wakeLock) acquireWakeLock();
  });

  checkServer();
}

init();
