import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { explainEntailment, verifyProof } from './proof.js';

const distDirectory = join(process.cwd(), 'dist');
const port = Number(process.env.PORT || 3001);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function safeDistPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const requestedPath = normalize(join(distDirectory, decoded));
  const relativePath = relative(distDirectory, requestedPath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return requestedPath;
}

function serveStatic(response, pathname) {
  const filePath = safeDistPath(pathname === '/' ? '/index.html' : pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { ok: false, error: '接口不存在' });
      return;
    }
    sendSpaIndex(response);
    return;
  }

  const contentType = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(response);
}

function sendSpaIndex(response) {
  const indexFile = join(distDirectory, 'index.html');
  if (!existsSync(indexFile)) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('前端尚未构建：请先运行 npm run build，或在开发模式使用 Vite。');
    return;
  }
  response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
  createReadStream(indexFile).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/verify') {
    try {
      const body = await readRequestBody(request);
      sendJson(response, 200, verifyProof(body));
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        valid: false,
        code: 'BAD_REQUEST',
        error: error instanceof SyntaxError ? '请求不是合法 JSON' : error.message
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/entailment') {
    try {
      const body = await readRequestBody(request);
      sendJson(response, 200, explainEntailment(body));
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        error: error instanceof SyntaxError ? '请求不是合法 JSON' : error.message
      });
    }
    return;
  }

  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (process.env.NODE_ENV === 'production') {
      serveStatic(response, url.pathname);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('开发模式请访问 Vite 开发服务器（默认 http://localhost:5173）。');
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: '接口不存在' });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`Proof checker API listening on http://localhost:${port}`);
  });
}

export { server };
