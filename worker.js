/**
 * Adaptador para Cloudflare Workers (alternativa à Vercel).
 *
 * As rotas /api/* são atendidas pelo backend; qualquer outro caminho é servido
 * a partir da pasta docs/ (binding ASSETS definido em wrangler.toml), de modo
 * que o Worker também pode hospedar a interface.
 */
import { handleApiRequest } from './backend/router.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Não encontrado', { status: 404 });
  },
};
