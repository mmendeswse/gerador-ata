/**
 * Servidor local (e para hospedagens Node como Render, Railway ou VPS).
 *
 *   npm start            → http://localhost:3000
 *
 * Serve a interface (pasta docs/) e a API (/api/*) na mesma origem, sem
 * nenhuma dependência externa. As variáveis são lidas do arquivo .env.
 *
 * Observação: o arquivo NÃO se chama "server.js" de propósito — a Vercel
 * trataria esse nome como um servidor Node único; nela usamos a pasta api/.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { handleApiRequest } from './backend/router.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = resolve(ROOT, process.env.STATIC_DIR || 'docs');

// --- .env -------------------------------------------------------------------
function loadDotEnv(file) {
  if (!existsSync(file)) return false;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
const hasEnvFile = loadDotEnv(join(ROOT, '.env'));

// "npm run teste-local" (ou: node local-server.js --teste) liga o provedor simulado,
// que funciona sem chave de API — útil para validar a instalação.
if (process.argv.includes('--teste')) process.env.AI_PROVIDER = 'mock';

// --- arquivos estáticos -----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Requisição inválida');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = normalize(join(STATIC_DIR, pathname));
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end('Acesso negado');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': statSync(filePath).size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

// --- ponte Node (req/res) -> API Web (Request/Response) ----------------------
async function serveApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });

  const response = await handleApiRequest(request, process.env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

const server = createServer((req, res) => {
  const isApi = req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?');
  if (isApi) {
    serveApi(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Erro interno do servidor.' } }));
    });
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405).end('Método não permitido');
    return;
  }
  serveStatic(req, res);
});

// Chamadas de IA podem levar minutos: sem limite de tempo por requisição.
server.requestTimeout = 0;
server.headersTimeout = 120_000;

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  console.log('');
  console.log('  GERADOR DE ATA E MOMENTO ABERTO');
  console.log(`  Interface e API em:  http://localhost:${port}`);
  console.log(`  Arquivo .env:        ${hasEnvFile ? 'carregado' : 'não encontrado (usando variáveis do sistema)'}`);
  console.log(`  Provedor de IA:      ${provider === 'mock' ? 'SIMULADO (modo de teste, sem IA)' : provider}`);
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
    console.log('  ATENÇÃO: GEMINI_API_KEY não definida. Copie .env.example para .env e preencha,');
    console.log('           ou rode "npm run teste-local" para o modo de teste sem IA.');
  }
  console.log(`  Senha de acesso:     ${process.env.ACCESS_PASSWORD ? 'exigida' : 'não exigida'}`);
  console.log('');
});
