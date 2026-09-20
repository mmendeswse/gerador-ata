/** Área "Vídeo da Reunião": selecionar, arrastar e soltar, ver dados do arquivo, remover e trocar. */

import { $, show } from '../lib/dom.js';
import { AppError } from '../lib/errors.js';
import { formatBytes, formatDuration } from '../lib/format.js';
import { getSettings } from '../settings.js';

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'avi', 'mkv', 'mpg', 'mpeg', 'wmv', '3gp', 'ts', 'mts', 'flv', 'ogv'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac', 'wma', 'amr'];

function extensionOf(name) {
  return (String(name).match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ?? '').toLowerCase();
}

/** Lança AppError com mensagem amigável quando o arquivo não pode ser usado. */
export function validateFile(file) {
  if (!file || typeof file.size !== 'number') throw new AppError('INVALID_FILE');
  const extension = extensionOf(file.name);
  const known = VIDEO_EXTENSIONS.includes(extension) || AUDIO_EXTENSIONS.includes(extension);
  const typed = /^(video|audio)\//.test(file.type || '');

  if (!known && !typed) {
    // Documentos, imagens, planilhas etc.
    throw new AppError(extension ? 'UNSUPPORTED_FORMAT' : 'INVALID_FILE', { detail: `Arquivo: ${file.name}` });
  }
  if (file.size === 0) throw new AppError('EMPTY_FILE');
  const { maxFileSizeBytes } = getSettings();
  if (file.size > maxFileSizeBytes) {
    throw new AppError('FILE_TOO_LARGE', { detail: `Tamanho: ${formatBytes(file.size)} · Limite: ${formatBytes(maxFileSizeBytes)}` });
  }
  return { extension, isAudio: AUDIO_EXTENSIONS.includes(extension) || (file.type || '').startsWith('audio/') };
}

/** Lê a duração usando o próprio navegador (quando ele reconhece o formato). */
function probeDuration(file) {
  return new Promise((resolve) => {
    const media = document.createElement(file.type?.startsWith('audio/') ? 'audio' : 'video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    media.preload = 'metadata';
    media.muted = true;
    media.onloadedmetadata = () => finish(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null);
    media.onerror = () => finish(null);
    media.src = url;
  });
}

export class UploadArea {
  /** @param {{ onChange: (file: File|null) => void, onError: (error: AppError) => void }} hooks */
  constructor({ onChange, onError }) {
    this.onChange = onChange;
    this.onError = onError;
    this.file = null;
    this.disabled = false;
    this.probeToken = 0;

    this.dropzone = $('#dropzone');
    this.input = $('#file-input');
    this.panel = $('#file-panel');

    this.dropzone.addEventListener('click', () => this.pick());
    this.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.pick();
      }
    });
    this.input.addEventListener('change', () => {
      if (this.input.files?.[0]) this.select(this.input.files[0]);
      this.input.value = ''; // permite escolher o mesmo arquivo de novo
    });
    $('#btn-change-file').addEventListener('click', () => this.pick());
    $('#btn-remove-file').addEventListener('click', () => this.clear());

    // Arrastar e soltar (na área destacada e também sobre o painel do arquivo atual).
    for (const target of [this.dropzone, this.panel]) {
      target.addEventListener('dragenter', (event) => this.onDrag(event, true));
      target.addEventListener('dragover', (event) => this.onDrag(event, true));
      target.addEventListener('dragleave', (event) => this.onDrag(event, false));
      target.addEventListener('drop', (event) => {
        this.onDrag(event, false);
        if (this.disabled) return;
        const files = event.dataTransfer?.files;
        if (files?.length > 1) this.onError(new AppError('INVALID_FILE', { detail: 'Solte apenas um arquivo por vez.' }));
        else if (files?.[0]) this.select(files[0]);
      });
    }
    // Soltar fora da área não deve fazer o navegador abrir o vídeo no lugar do sistema.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
  }

  onDrag(event, active) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.disabled) this.dropzone.classList.toggle('is-dragover', active);
  }

  pick() {
    if (!this.disabled) this.input.click();
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    this.dropzone.setAttribute('aria-disabled', String(disabled));
    $('#btn-change-file').disabled = disabled;
    $('#btn-remove-file').disabled = disabled;
  }

  select(file) {
    if (this.disabled) return;
    let info;
    try {
      info = validateFile(file);
    } catch (error) {
      this.onError(error);
      return;
    }
    this.file = file;
    show(this.dropzone, false);
    show(this.panel, true);
    $('#file-name').textContent = file.name;
    $('#file-size').textContent = formatBytes(file.size);
    $('#file-format').textContent = `${info.extension.toUpperCase() || '—'}${info.isAudio ? ' (áudio)' : ''}`;
    $('#file-duration').textContent = 'verificando…';
    show($('#file-note'), false);
    this.onChange(file);

    const token = ++this.probeToken;
    probeDuration(file).then((duration) => {
      if (token !== this.probeToken) return;
      if (duration) {
        $('#file-duration').textContent = formatDuration(duration);
      } else {
        $('#file-duration').textContent = 'será identificada no processamento';
        const note = $('#file-note');
        note.textContent =
          'Este navegador não consegue pré-visualizar o formato, mas o processamento usa um componente próprio (FFmpeg) e deve funcionar normalmente. Se houver erro, converta o vídeo para MP4.';
        show(note, true);
      }
    });
  }

  clear() {
    if (this.disabled) return;
    this.probeToken += 1;
    this.file = null;
    show(this.panel, false);
    show(this.dropzone, true);
    this.onChange(null);
    this.dropzone.focus();
  }
}
