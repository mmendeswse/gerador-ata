/**
 * Erros da interface: códigos estáveis + mensagens amigáveis em português.
 */

export class AppError extends Error {
  constructor(code, { message, detail, cause, retryAfterSeconds } = {}) {
    super(message || MESSAGES[code]?.title || MESSAGES.PROCESSING_ERROR.title);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail || '';
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    if (cause) this.cause = cause;
  }
}

const SUPPORT_FORMATS = 'MP4, MOV, WEBM, AVI ou MKV (ou um áudio MP3, M4A, WAV, OGG ou FLAC)';

export const MESSAGES = {
  // Arquivo
  INVALID_FILE: { title: 'Arquivo inválido.', hint: `Selecione um arquivo de vídeo ${SUPPORT_FORMATS}.` },
  EMPTY_FILE: { title: 'O arquivo está vazio.', hint: 'Verifique se a gravação foi concluída corretamente e selecione o arquivo novamente.' },
  UNSUPPORTED_FORMAT: { title: 'Formato não suportado.', hint: `Use ${SUPPORT_FORMATS}. Se necessário, converta o vídeo para MP4.` },
  FILE_TOO_LARGE: { title: 'Arquivo muito grande.', hint: 'Reduza a resolução do vídeo, exporte somente o áudio ou divida a gravação em partes.' },
  FILE_UNREADABLE: { title: 'Não foi possível ler o arquivo.', hint: 'O arquivo pode ter sido movido, renomeado ou estar em uma unidade desconectada. Selecione-o novamente.' },

  // Extração de áudio
  FFMPEG_LOAD_ERROR: { title: 'Não foi possível carregar o componente de extração de áudio.', hint: 'Ele é baixado da internet na primeira utilização (cerca de 31 MB). Verifique a conexão ou eventuais bloqueios da rede e tente novamente.' },
  DECODE_ERROR: { title: 'Não foi possível processar o vídeo. Verifique o arquivo e tente novamente.', hint: 'O arquivo pode estar corrompido ou usar um formato não suportado. Converter o vídeo para MP4 costuma resolver.' },
  NO_AUDIO: { title: 'O vídeo não possui faixa de áudio.', hint: 'Sem áudio não é possível transcrever a reunião. Verifique se a gravação foi feita com som.' },
  SILENT_AUDIO: { title: 'O áudio do vídeo está mudo ou com volume baixíssimo.', hint: 'Não há fala audível para transcrever. Verifique a gravação.' },
  NO_SPEECH: { title: 'Nenhuma fala foi identificada no áudio.', hint: 'Verifique se o arquivo corresponde à gravação da reunião.' },
  OUT_OF_MEMORY: { title: 'O navegador ficou sem memória ao processar o vídeo.', hint: 'Feche outras abas e programas e tente de novo, de preferência em um computador (não no celular).' },

  // Servidor
  BACKEND_NOT_CONFIGURED: { title: 'O servidor de processamento não está configurado.', hint: 'Abra “Configurações” e informe o endereço do servidor (backend). Veja o passo a passo no README do projeto.' },
  NETWORK_ERROR: { title: 'Falha de conexão com o servidor.', hint: 'Verifique sua internet. Se o problema continuar, confira o endereço do servidor em “Configurações” e se a origem deste site está autorizada no servidor (ALLOWED_ORIGINS).' },
  TIMEOUT: { title: 'O processamento excedeu o tempo limite.', hint: 'O serviço pode estar sobrecarregado. Tente novamente; o que já foi transcrito será reaproveitado.' },
  UPLOAD_ERROR: { title: 'Erro ao enviar o áudio ao servidor.', hint: 'Tente novamente. Se persistir, reduza a duração dos trechos em “Configurações”.' },
  PAYLOAD_TOO_LARGE: { title: 'O trecho de áudio excede o limite aceito pelo servidor.', hint: 'Reduza a duração dos trechos em “Configurações → Opções avançadas” e processe novamente.' },
  AUTH_REQUIRED: { title: 'Este servidor exige senha de acesso.', hint: 'Informe a senha para continuar.' },
  AUTH_INVALID: { title: 'Senha de acesso incorreta.', hint: 'Confira a senha com o responsável pelo servidor.' },
  SERVER_NOT_CONFIGURED: { title: 'O servidor ainda não tem a chave da IA configurada.', hint: 'Defina a variável de ambiente GEMINI_API_KEY no servidor e publique-o novamente (veja o README).' },
  BAD_REQUEST: { title: 'O servidor recusou a requisição.', hint: 'Atualize a página e tente novamente. Se persistir, verifique se interface e servidor estão na mesma versão.' },

  // IA
  AI_RATE_LIMIT: { title: 'Limite de uso do serviço de IA atingido.', hint: 'Aguarde alguns instantes e tente novamente. Em contas gratuitas o limite por minuto é baixo.' },
  AI_QUOTA_EXHAUSTED: { title: 'A cota do serviço de IA se esgotou.', hint: 'O limite diário da camada gratuita (ou o limite de gastos) foi atingido. Tente mais tarde ou ative o faturamento no provedor de IA. O que já foi transcrito fica guardado enquanto esta aba estiver aberta.' },
  AI_UNAVAILABLE: { title: 'O serviço de IA está temporariamente indisponível.', hint: 'Tente novamente em alguns minutos; o que já foi transcrito será reaproveitado.' },
  AI_TIMEOUT: { title: 'O serviço de IA demorou mais do que o tempo limite.', hint: 'Tente novamente. Se persistir, reduza a duração dos trechos em “Configurações”.' },
  AI_AUTH: { title: 'A chave de API do servidor foi recusada pelo serviço de IA.', hint: 'Verifique a variável GEMINI_API_KEY no servidor.' },
  AI_MODEL_NOT_FOUND: { title: 'O modelo de IA configurado não está disponível.', hint: 'Ajuste a variável GEMINI_MODEL no servidor para um modelo vigente.' },
  AI_BLOCKED: { title: 'O serviço de IA recusou-se a processar este conteúdo.', hint: 'O filtro de segurança do provedor bloqueou a solicitação. Tente gerar novamente.' },
  AI_BAD_RESPONSE: { title: 'O serviço de IA retornou uma resposta inválida.', hint: 'Isso costuma ser passageiro. Tente novamente.' },
  AI_ERROR: { title: 'Erro da API de IA.', hint: 'Tente novamente. Se persistir, consulte os detalhes técnicos.' },
  TRANSCRIPTION_ERROR: { title: 'Erro na transcrição do áudio.', hint: 'Tente novamente; os trechos já transcritos serão reaproveitados.' },

  // Geral
  PROCESSING_ERROR: { title: 'Não foi possível processar o vídeo. Verifique o arquivo e tente novamente.', hint: '' },
  CANCELED: { title: 'Processamento cancelado.', hint: 'Nada foi perdido: você pode retomar de onde parou.' },
  INTERNAL: { title: 'Erro interno do servidor.', hint: 'Tente novamente em instantes.' },
};

/** Códigos em que vale a pena tentar de novo automaticamente. */
export const TRANSIENT_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BAD_RESPONSE', 'INTERNAL']);

export function describeError(error) {
  const appError = toAppError(error);
  const entry = MESSAGES[appError.code] ?? MESSAGES.PROCESSING_ERROR;
  return { code: appError.code, title: entry.title, hint: entry.hint, detail: appError.detail };
}

export function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error?.name === 'AbortError') return new AppError('CANCELED', { cause: error });
  const text = String(error?.message ?? error ?? '');
  if (/out of memory|memory access out of bounds|allocation failed|Array buffer allocation/i.test(text)) {
    return new AppError('OUT_OF_MEMORY', { detail: text, cause: error });
  }
  if (error?.name === 'NotReadableError' || error?.name === 'NotFoundError') {
    return new AppError('FILE_UNREADABLE', { detail: text, cause: error });
  }
  return new AppError('PROCESSING_ERROR', { detail: text, cause: error });
}
