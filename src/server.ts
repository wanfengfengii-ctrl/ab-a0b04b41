import { createServer, type Server, type ServerResponse } from 'node:http';
import { auditTrios } from './audit.js';
import { ApiError } from './errors.js';
import { parseTrioUpload } from './multipart.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createApp(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET' });
        res.end();
        return;
      }
      sendJson(res, 200, { status: 'ok', service: 'trio-haplotype-audit' });
      return;
    }

    if (url.pathname === '/api/trios/audit') {
      if (method !== 'POST') {
        sendJson(res, 405, {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: '该端点仅接受 POST（multipart/form-data）',
          },
        });
        return;
      }
      parseTrioUpload(req)
        .then(({ files }) => {
          // 文件结构 / 位点不对齐：ApiError → 整体拒绝（4xx）。
          // 遗传 / 相位不一致：属于正常裁决结果 → 200，区段 verdict=INCONSISTENT。
          const result = auditTrios(files.father, files.mother, files.child);
          sendJson(res, 200, { status: 'ok', ...result });
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError) {
            sendJson(res, err.status, {
              error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
              },
            });
            return;
          }
          console.error('未预期错误：', err);
          sendJson(res, 500, {
            error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
          });
        });
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '路径不存在' } });
  });
}

// 仅在被直接运行时监听，供测试以 createApp() 启停用例服务器。
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`trio-haplotype-audit 监听 http://${host}:${port}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
