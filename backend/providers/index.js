/**
 * Seleção do provedor de IA.
 *
 * Para acrescentar outro serviço (OpenAI, AssemblyAI, Deepgram...), crie um
 * módulo que exponha { transcribe, generateJson, generateText } com as mesmas
 * assinaturas e registre-o aqui.
 */

import { Errors } from '../errors.js';
import { createGeminiProvider } from './gemini.js';
import { createLocalProvider } from './local.js';
import { createMockProvider } from './mock.js';

export function createProvider(config) {
  if (config.provider === 'mock') return createMockProvider(config);
  if (config.provider === 'gemini') return createGeminiProvider(config);
  if (config.provider === 'local') return createLocalProvider(config);
  throw Errors.serverNotConfigured(
    `Provedor de IA desconhecido em AI_PROVIDER: "${config.provider}". Use "gemini", "local" ou "mock".`,
  );
}
