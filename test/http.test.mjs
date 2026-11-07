import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requestJSON } from '../src/http.mjs';

async function withServer(run, handler) {
  const dir = await mkdtemp('/private/tmp/pcc-http-test-');
  const socket = join(dir, 's');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(socket, resolve));
  try { await run(socket); } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('HTTP transport sends and receives JSON through a Unix socket', async () => {
  await withServer(async (socket) => {
    const result = await requestJSON(socket, '/v1/chat/completions', { body: { model: 'pcc' } });
    assert.deepEqual(result, { received: 'pcc' });
  }, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => res.end(JSON.stringify({ received: JSON.parse(data).model })));
  });
});

test('HTTP errors, invalid JSON, and oversized responses are rejected', async () => {
  for (const mode of ['error', 'invalid', 'large']) {
    await withServer(async (socket) => {
      await assert.rejects(requestJSON(socket, '/', { maxBytes: 32 }));
    }, (_req, res) => {
      if (mode === 'error') { res.writeHead(429); res.end('{}'); }
      if (mode === 'invalid') res.end('not json');
      if (mode === 'large') res.end(JSON.stringify({ text: 'a'.repeat(100) }));
    });
  }
});

test('HTTP deadline stops a server that does not respond', async () => {
  await withServer(async (socket) => {
    await assert.rejects(requestJSON(socket, '/', { timeoutMs: 30 }), /timed out/);
  }, () => {});
});

test('HTTP caller cancellation interrupts a pending request', async () => {
  await withServer(async (socket) => {
    const controller = new AbortController();
    const pending = requestJSON(socket, '/', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }, () => {});
});
