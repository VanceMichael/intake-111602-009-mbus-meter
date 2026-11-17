import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';
import { SessionStore } from './sessions.mjs';
import { collect } from './readout.mjs';
import { buildLedger, lookupQuantity } from './ledger.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

function sessionView(session) {
  return {
    id: session.id,
    source: session.source,
    path: session.path,
    device: session.device,
    status: session.status,
    error: session.error,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    progress: {
      frames: session.frames.length,
      records: session.frames.reduce((count, frame) => count + frame.records.length, 0),
      nextFcb: session.status === 'complete' ? null : session.fcb,
    },
    frames: session.frames.map(frame => ({
      digest: frame.digest, bytes: frame.bytes, fcb: frame.fcb, access: frame.access,
      more: frame.more, manufacturerTail: frame.manufacturerTail, receivedAt: frame.receivedAt,
    })),
    rejected: session.rejected,
    ledger: buildLedger(session),
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const sessions = await new SessionStore(root).initialize();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await readBody(request);
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'POST' && url.pathname === '/readouts') {
        // 一次设备资料领取：首帧 + 续帧组合，中断也留会话
        const input = await readBody(request);
        const session = await sessions.create({ source, path: input.path || profile.previewPath });
        const collected = await collect(session, { client: new SourceClient(source), catalog, sessions });
        response.statusCode = 201;
        return response.end(JSON.stringify(sessionView(collected)));
      }
      if (request.method === 'GET' && url.pathname === '/readouts') {
        const all = await sessions.list();
        return response.end(JSON.stringify(all.map(session => ({
          id: session.id, device: session.device, status: session.status,
          error: session.error, startedAt: session.startedAt, completedAt: session.completedAt,
          frames: session.frames.length,
        }))));
      }
      if (url.pathname.startsWith('/readouts/')) {
        const [id, action] = url.pathname.slice('/readouts/'.length).split('/');
        const session = await sessions.get(id);
        if (request.method === 'POST' && action === 'resume') {
          if (session.status === 'complete') return response.end(JSON.stringify(sessionView(session)));
          const collected = await collect(session, { client: new SourceClient(source), catalog, sessions });
          return response.end(JSON.stringify(sessionView(collected)));
        }
        if (request.method === 'GET' && action === 'ledger') {
          return response.end(JSON.stringify(buildLedger(session)));
        }
        if (request.method === 'GET' && action === 'quantity') {
          const number = name => url.searchParams.has(name) ? Number(url.searchParams.get(name)) : null;
          return response.end(JSON.stringify(lookupQuantity(session, {
            kind: url.searchParams.get('kind'),
            storage: number('storage'),
            tariff: number('tariff'),
          })));
        }
        if (request.method === 'GET' && !action) return response.end(JSON.stringify(sessionView(session)));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, sessions,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
