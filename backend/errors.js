/**
 * Erros padronizados do backend.
 *
 * Cada erro possui um código estável (usado pelo frontend para exibir a
 * mensagem amigável correta), um status HTTP e uma mensagem em português.
 * Nenhum erro carrega conteúdo da reunião (transcrição, áudio ou documentos).
 */

export class AppError extends Error {
  /**
   * @param {string} code    Código estável (ex.: "AI_RATE_LIMIT").
   * @param {string} message Mensagem em português, segura para exibir ao usuário.
   * @param {number} status  Status HTTP.
   * @param {object} [extra] Dados adicionais não sensíveis (ex.: retryAfterSeconds).
   */
  constructor(code, message, status = 500, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const Errors = {
  badRequest: (message = 'Requisição inválida.') => new AppError('BAD_REQUEST', message, 400),

  authRequired: () =>
    new AppError('AUTH_REQUIRED', 'Este servidor exige senha de acesso.', 401),

  authInvalid: () => new AppError('AUTH_INVALID', 'Senha de acesso incorreta.', 401),

  notFound: () => new AppError('NOT_FOUND', 'Recurso não encontrado.', 404),

  methodNotAllowed: () => new AppError('METHOD_NOT_ALLOWED', 'Método HTTP não permitido.', 405),

  payloadTooLarge: (limitMb) =>
    new AppError(
      'PAYLOAD_TOO_LARGE',
      `O conteúdo enviado excede o limite aceito pelo servidor (${limitMb} MB).`,
      413,
    ),

  unsupportedMedia: (message = 'Formato de áudio não suportado pelo serviço de transcrição.') =>
    new AppError('UNSUPPORTED_MEDIA', message, 415),

  serverNotConfigured: (message) =>
    new AppError(
      'SERVER_NOT_CONFIGURED',
      message ||
        'O servidor ainda não foi configurado: defina a variável de ambiente GEMINI_API_KEY.',
      500,
    ),

  aiRateLimit: (retryAfterSeconds) =>
    new AppError(
      'AI_RATE_LIMIT',
      'O limite de uso do serviço de IA foi atingido momentaneamente.',
      429,
      { retryAfterSeconds },
    ),

  aiQuotaExhausted: () =>
    new AppError(
      'AI_QUOTA_EXHAUSTED',
      'A cota do serviço de IA se esgotou (limite diário da camada gratuita ou limite de gastos).',
      429,
    ),

  aiUnavailable: () =>
    new AppError('AI_UNAVAILABLE', 'O serviço de IA está temporariamente indisponível.', 503),

  aiTimeout: () =>
    new AppError('AI_TIMEOUT', 'O serviço de IA demorou mais do que o tempo limite.', 504),

  aiAuth: () =>
    new AppError(
      'AI_AUTH',
      'A chave de API configurada no servidor foi recusada pelo serviço de IA.',
      502,
    ),

  aiModelNotFound: (models) =>
    new AppError(
      'AI_MODEL_NOT_FOUND',
      `Nenhum dos modelos de IA configurados está disponível (${models}).`,
      502,
    ),

  aiBlocked: (reason) =>
    new AppError(
      'AI_BLOCKED',
      'O serviço de IA recusou-se a processar este conteúdo (filtro de segurança do provedor).',
      422,
      { reason },
    ),

  aiBadResponse: () =>
    new AppError('AI_BAD_RESPONSE', 'O serviço de IA retornou uma resposta inválida.', 502),

  aiError: (detail) =>
    new AppError('AI_ERROR', 'O serviço de IA retornou um erro.', 502, detail ? { detail } : {}),

  internal: () => new AppError('INTERNAL', 'Erro interno do servidor.', 500),
};
