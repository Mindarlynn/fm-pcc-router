import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, chmod, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const skill = await readFile(new URL('../integrations/codex/skills/fm-pcc-router/SKILL.md', import.meta.url), 'utf8');
const recipes = [...skill.matchAll(/```javascript\n([\s\S]*?)\n```/g)];
assert.equal(recipes.length, 1, 'exercise the exact recipe shipped in the skill');
const source = recipes[0][1];
const { runSkill, openRPC } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const threadId = '00000000-0000-7000-8000-000000000001';
const selected = { model: 'gpt-selected', effort: 'high', reason: 'Fits the task.' };

function fixture() {
  const calls = [];
  const state = { turnId: 'turn-original', model: 'gpt-original', routes: 0, closed: 0, opens: 0 };
  const rpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (state.reject?.[method]) throw state.reject[method];
      if (state.answer?.[method]) return state.answer[method](params);
      if (method === 'initialize') return {};
      if (method === 'experimentalFeature/list') return { data: [{ name: 'step_model_switching', enabled: true }] };
      if (method === 'thread/read') return { thread: { id: threadId, model: state.model, status: { type: 'active' } } };
      if (method === 'thread/turns/list') return { data: [{ id: state.turnId, status: 'inProgress' }] };
      if (method === 'model/list') return { data: [{ id: selected.model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
      if (method === 'turn/settings/update') return { status: 'applied' };
      if (method === 'thread/settings/update') { state.model = params.model; return {}; }
      throw new Error('Unexpected method: ' + method);
    },
    notify(method) { calls.push({ method }); },
    close() { state.closed++; },
  };
  const dependencies = {
    env: { CODEX_THREAD_ID: threadId, CODEX_HOME: '/private/test-codex' },
    routeTask: async task => { assert.equal(task, 'Route this task.'); state.routes++; return selected; },
    audit: model => { assert.equal(model, selected.model); return 'audit-id'; },
    stat: async path => path.endsWith('.sock') ? { isSocket: () => true, uid: process.getuid(), mode: 0o755 }
      : { isDirectory: () => true, uid: process.getuid(), mode: 0o700 },
    realpath: async path => path,
    open: async () => { state.opens++; return rpc; },
  };
  return { calls, state, dependencies, run: options => runSkill('Route this task.', { cli: true, ...options }, dependencies) };
}
const writes = f => f.calls.filter(c => /settings\/update$/.test(c.method));
const denied = message => Object.assign(new Error(message), { code: -32600 });

test('the current chat and future turns use one existing router decision, without claiming execution', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'applied');
  assert.equal(result.threadId, threadId);
  assert.equal(result.turnId, 'turn-original');
  assert.equal(result.model, selected.model);
  assert.equal(result.effort, 'high');
  assert.equal(result.execution, 'unverified');
  assert.equal(result.effortStatus, 'submitted');
  assert.equal(result.auditId, 'audit-id');
  assert.equal(f.state.routes, 1);
  assert.deepEqual(writes(f), [
    { method: 'turn/settings/update', params: { threadId, turnId: 'turn-original', model: selected.model, effort: 'high' } },
    { method: 'thread/settings/update', params: { threadId, model: selected.model, effort: 'high' } },
  ]);
  assert.equal(f.state.closed, 1);
  assert.equal(f.calls[0].params.capabilities.experimentalApi, true);
});

test('app or uncertain interfaces return the same route for native fallback without connecting', async () => {
  const f = fixture();
  const result = await f.run({ cli: false });
  assert.equal(result.status, 'fallback');
  assert.equal(result.model, selected.model);
  assert.equal(f.state.routes, 1);
  assert.equal(f.state.opens, 0);
  assert.deepEqual(writes(f), []);
});

test('a missing thread identity, missing socket or disabled flag preserves native fallback', async () => {
  for (const kind of ['identity', 'socket', 'flag']) {
    const f = fixture();
    if (kind === 'identity') delete f.dependencies.env.CODEX_THREAD_ID;
    if (kind === 'socket') f.dependencies.stat = async () => { throw Object.assign(new Error('No existing socket'), { code: 'ENOENT' }); };
    if (kind === 'flag') f.state.answer = { 'experimentalFeature/list': () => ({ data: [{ name: 'step_model_switching', enabled: false }] }) };
    const result = await f.run();
    assert.equal(result.status, 'fallback', kind);
    assert.equal(f.state.routes, 1);
    assert.deepEqual(writes(f), []);
    assert(!f.calls.some(c => /thread\/(start|resume)|enablement\/set/.test(c.method)));
  }
});

test('sandbox denial requests normal approval instead of bypassing it through fallback', async () => {
  const f = fixture();
  f.dependencies.stat = async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); };
  await assert.rejects(f.run(), /Permission denied/);
  assert.equal(f.state.routes, 0);
  assert.deepEqual(writes(f), []);
});

test('an unowned or nonsocket endpoint, or an accessible parent directory, is never contacted', async () => {
  for (const overrides of [{ uid: process.getuid() + 1 }, { publicParent: true }, { isSocket: () => false }]) {
    const f = fixture();
    f.dependencies.stat = async path => path.endsWith('.sock') ? { isSocket: () => true, uid: process.getuid(), ...overrides }
      : { isDirectory: () => true, uid: process.getuid(), mode: overrides.publicParent ? 0o755 : 0o700 };
    assert.equal((await f.run()).status, 'fallback');
    assert.equal(f.state.opens, 0);
  }
});

test('Codex socket aliases resolve to a private owned target, including targets without a .sock suffix', async () => {
  const f = fixture();
  f.dependencies.realpath = async () => '/private/daemon/opaque-target';
  f.dependencies.stat = async path => path === '/private/daemon/opaque-target'
    ? { isSocket: () => true, uid: process.getuid() }
    : { isDirectory: () => true, uid: process.getuid(), mode: 0o700 };
  f.dependencies.open = async path => {
    assert.equal(path, '/private/daemon/opaque-target');
    return { call: async (method, params) => {
      f.calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'experimentalFeature/list') return { data: [{ name: 'step_model_switching', enabled: false }] };
      assert.fail('disabled flag must stop direct mode');
    }, notify() {}, close() {} };
  };
  assert.equal((await f.run()).status, 'fallback');
  assert.equal(f.state.routes, 1);
  const invalid = fixture();
  invalid.dependencies.realpath = async () => '/public/opaque-target';
  invalid.dependencies.stat = async path => path === '/public'
    ? { isDirectory: () => true, uid: process.getuid(), mode: 0o755 }
    : path === '/public/opaque-target' ? { isSocket: () => true, uid: process.getuid() }
      : { isDirectory: () => true, uid: process.getuid(), mode: 0o700 };
  assert.equal((await invalid.run()).status, 'fallback');
  assert.equal(invalid.state.opens, 0);
});

test('feature and model pagination reaches a supported pair and rejects repeated cursors', async () => {
  const f = fixture();
  f.state.answer = {
    'experimentalFeature/list': p => p.cursor ? { data: [{ name: 'step_model_switching', enabled: true }] } : { data: [], nextCursor: 'features-2' },
    'model/list': p => p.cursor ? { data: [{ id: selected.model, supportedReasoningEfforts: ['high'] }] } : { data: [], nextCursor: 'models-2' },
  };
  assert.equal((await f.run()).status, 'applied');
  const invalid = fixture();
  invalid.state.answer = { 'experimentalFeature/list': () => ({ data: [], nextCursor: 'repeat' }) };
  assert.equal((await invalid.run()).status, 'fallback');
  assert.deepEqual(writes(invalid), []);
});

test('a pair unavailable on the connected server falls back without a second PCC request', async () => {
  const f = fixture();
  f.state.answer = { 'model/list': () => ({ data: [{ id: selected.model, supportedReasoningEfforts: ['low'] }] }) };
  assert.equal((await f.run()).status, 'fallback');
  assert.equal(f.state.routes, 1);
  assert.deepEqual(writes(f), []);
});

test('a turn change during PCC selection stops instead of writing into the new turn', async () => {
  const f = fixture();
  f.dependencies.routeTask = async () => { f.state.routes++; f.state.turnId = 'different-turn'; return selected; };
  assert.equal((await f.run()).status, 'stopped');
  assert.deepEqual(writes(f), []);
});

test('an explicit model-compatibility rejection permits one native fallback using the same decision', async () => {
  const f = fixture();
  f.state.reject = { 'turn/settings/update': denied('the destination changes the admitted node REPL review requirement') };
  const result = await f.run();
  assert.equal(result.status, 'fallback');
  assert.match(result.reason, /node REPL/);
  assert.equal(f.state.routes, 1);
  assert.equal(writes(f).length, 1);
});

test('uncertain, unavailable and unexpected turn-update outcomes never start fallback work', async () => {
  for (const kind of ['timeout', 'unavailable', 'malformed']) {
    const f = fixture();
    if (kind === 'timeout') f.state.reject = { 'turn/settings/update': new Error('RPC timeout') };
    else f.state.answer = { 'turn/settings/update': () => kind === 'unavailable' ? { status: 'targetUnavailable' } : {} };
    assert.equal((await f.run()).status, 'stopped', kind);
    assert.equal(writes(f).length, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('a partial future-turn failure or mismatched saved model is reported as stopped', async () => {
  for (const kind of ['failure', 'mismatch']) {
    const f = fixture();
    if (kind === 'failure') f.state.reject = { 'thread/settings/update': denied('Not supported') };
    else f.state.answer = { 'thread/settings/update': () => ({}) };
    const result = await f.run();
    assert.equal(result.status, 'stopped');
    assert.match(result.reason, /live turn was updated/);
    assert.equal(writes(f).length, 2);
    assert.equal(f.state.routes, 1);
  }
});

test('a PCC selection failure closes the connection without writing model settings', async () => {
  const f = fixture();
  f.dependencies.routeTask = async () => { throw new Error('PCC failed'); };
  await assert.rejects(f.run(), /PCC failed/);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(writes(f), []);
});

function frame(value, { opcode = 1, fin = true } = {}) {
  const payload = Buffer.from(value);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (fin ? 128 : 0) | opcode;
  if (header.length === 2) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}

async function serverFixture(t, onMessage, { validHandshake = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pcc-skill-ws-'));
  const path = join(root, 'server.sock');
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + (validHandshake ? accept : 'wrong') + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let n = buffer[1] & 127, offset = 2;
        assert(buffer[1] & 128, 'client frames must be masked');
        if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + n) return;
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + n));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        const opcode = buffer[0] & 15; buffer = buffer.subarray(offset + 4 + n);
        if (opcode === 1) onMessage(JSON.parse(body.toString()), socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return path;
}

test('the shipped WebSocket client handles masked requests, ping, fragmented JSON and split TCP input', async t => {
  const value = 'x'.repeat(300);
  const path = await serverFixture(t, (request, socket) => {
    const json = JSON.stringify({ id: request.id, result: { value } });
    socket.write(frame('ping', { opcode: 9 }));
    socket.write(frame(json.slice(0, 100), { fin: false }));
    const rest = frame(json.slice(100), { opcode: 0 });
    socket.write(rest.subarray(0, 1));
    setImmediate(() => socket.write(rest.subarray(1)));
  });
  const rpc = await openRPC(path, 500);
  try { assert.deepEqual(await rpc.call('test', { value: 'y'.repeat(300) }), { value }); }
  finally { rpc.close(); }
});

test('protocol errors and rejected handshakes fail closed', async t => {
  const invalid = await serverFixture(t, () => {}, { validHandshake: false });
  await assert.rejects(openRPC(invalid, 500), /Invalid handshake/);
  for (const kind of ['JSON', 'large', 'masked', 'closed', 'rejected']) {
    const path = await serverFixture(t, (request, socket) => {
      if (kind === 'JSON') socket.write(frame('invalid JSON'));
      if (kind === 'large') { const h = Buffer.alloc(10); h[0] = 129; h[1] = 127; h.writeBigUInt64BE(2097153n, 2); socket.write(h); }
      if (kind === 'masked') socket.write(Buffer.from([129, 128]));
      if (kind === 'closed') socket.destroy();
      if (kind === 'rejected') socket.write(frame(JSON.stringify({ id: request.id, error: { code: -32600, message: 'unsupported' } })));
    });
    const rpc = await openRPC(path, 500);
    try { await assert.rejects(rpc.call('test', {}), kind === 'rejected' ? { code: -32600 } : undefined); }
    finally { rpc.close(); }
  }
});

test('a nonresponding server times out and its connection can be closed', async t => {
  const path = await serverFixture(t, () => {});
  const rpc = await openRPC(path, 30);
  try { await assert.rejects(rpc.call('test', {}), /RPC timeout/); }
  finally { rpc.close(); }
});

test('the literal skill recipe runs as a temporary file and preserves multibyte task input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pcc-skill-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'recipe.mjs'); await writeFile(script, source);
  const integration = join(root, 'data/fm-pcc-router/codex/integrations/codex');
  await mkdir(integration, { recursive: true });
  await writeFile(join(integration, 'codex-route.mjs'), 'export async function chooseCodexRoute(task) { if(task !== "한국어🙂") throw new Error("task changed"); return {model:"test-model",effort:"low"}; }');
  await writeFile(join(integration, 'codex-audit.mjs'), 'export function beginCodexAudit() { return undefined; }');
  const child = spawn(process.execPath, [script], { env: { ...process.env, XDG_DATA_HOME: join(root, 'data') } });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const done = new Promise(resolve => child.on('close', resolve));
  const bytes = Buffer.from('한국어🙂');
  child.stdin.write(bytes.subarray(0, 1));
  await new Promise(resolve => setTimeout(resolve, 30));
  child.stdin.end(bytes.subarray(1));
  assert.equal(await done, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'fallback');
});
