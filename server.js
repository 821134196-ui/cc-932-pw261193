import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EngineError,
  confirmStep,
  createInitialState,
  createMidwayDisasterState,
  getView,
  unplugTemporaryPower,
  updateCapacity,
} from './public/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;

let state = createInitialState();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendView(res, view, status = 200) {
  sendJson(res, status, { ok: true, state: view });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new EngineError('BODY_TOO_LARGE', '请求体过大', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new EngineError('BAD_JSON', '请求体不是合法 JSON', 400);
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(rootDir, requested));
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== path.join(rootDir, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    // 对带扩展名的缺失资源直接 404；前端路由路径回退到入口页。
    if (path.extname(pathname)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const index = await readFile(path.join(rootDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendView(res, getView(state));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/reset') {
        const body = await readJsonBody(req).catch(() => ({}));
        state = body?.scenario === 'midway' ? createMidwayDisasterState() : createInitialState();
        sendView(res, getView(state));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/demo/midway') {
        state = createMidwayDisasterState();
        sendView(res, getView(state));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/power/unplug-temp') {
        const body = await readJsonBody(req).catch(() => ({}));
        const view = unplugTemporaryPower(state, body?.feedId || 'tp-7');
        sendView(res, view);
        return;
      }

      const confirmMatch = pathname.match(/^\/api\/steps\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmMatch) {
        let stepId;
        try {
          stepId = decodeURIComponent(confirmMatch[1]);
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'BAD_STEP_ID', message: '步骤 ID 编码不合法' } });
          return;
        }
        try {
          const view = confirmStep(state, stepId);
          sendView(res, view);
        } catch (error) {
          if (error instanceof EngineError) {
            sendJson(res, error.status, {
              ok: false,
              error: { code: error.code, message: error.message },
              state: getView(state),
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === 'PATCH' && pathname === '/api/capacities') {
        const body = await readJsonBody(req);
        const updates = Array.isArray(body.updates)
          ? body.updates
          : [{ kind: body.kind, resourceId: body.resourceId, value: body.value }];

        let view = getView(state);
        for (const update of updates) {
          view = updateCapacity(state, update.kind, update.resourceId, update.value);
        }
        sendView(res, view);
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'API 不存在' } });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (error) {
    const status = error instanceof EngineError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, {
      ok: false,
      error: {
        code: error.code ?? 'INTERNAL',
        message: error.message ?? '服务器内部错误',
      },
      state: status === 500 ? undefined : getView(state),
    });
  }
};

const portFromEnv = process.env.PORT && process.env.PORT.trim() ? Number(process.env.PORT) : null;
const requestedPort = Number.isFinite(portFromEnv) ? portFromEnv : null;
const ports = requestedPort !== null ? [requestedPort] : [5173, 3000, 8000, 4173];
const servers = [];

for (const port of ports) {
  const server = http.createServer(handler);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`端口 ${port} 已被占用，跳过该端口`);
    } else {
      console.error(error);
      process.exitCode = 1;
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`机房搬迁规划台已启动: http://localhost:${actualPort}`);
  });
  servers.push(server);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const server of servers) server.close();
    process.exit(0);
  });
}
