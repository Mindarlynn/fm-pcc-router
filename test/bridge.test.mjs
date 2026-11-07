import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PCCBridge, validatePCCReply } from '../src/bridge.mjs';
import { shellQuote, parseTerminalSession } from '../src/terminal.mjs';

function makeBridge(options = {}) {
  return new PCCBridge({ checkAvailable: async () => {}, ...options });
}

function response(nonce, overrides = {}) {
  return { model: 'pcc', choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ ok: true, nonce }), refusal: null,
  } }], ...overrides };
}

test('PCC validation accepts only the current complete PCC reply', () => {
  assert.deepEqual(validatePCCReply(response('current'), 'current'), { model: 'pcc', ok: true });
  const wrongField = response('current');
  wrongField.choices[0].message.content = JSON.stringify({ ok: true, nonce: 'current', extra: true });
  const refusal = response('current');
  refusal.choices[0].message.refusal = 'no';
  const malformed = response('current');
  malformed.choices[0].message.content = '```json\n{}\n```';
  for (const invalid of [response('stale'), response('current', { model: 'system' }),
    response('current', { choices: [] }), response('current', { choices: [{ finish_reason: 'length' }] }),
    wrongField, refusal, malformed]) {
    assert.throws(() => validatePCCReply(invalid, 'current'));
  }
});

test('startup checks the PCC executable before creating or launching the service', async () => {
  let launches = 0;
  const bridge = new PCCBridge({ checkAvailable: async () => { throw new Error('missing fm'); },
    launch: async () => { launches++; }, stop: async () => {} });
  await assert.rejects(bridge.probe(), /missing fm/);
  assert.equal(launches, 0);
  await bridge.dispose();
});

test('the shared bridge rejects local-model or streaming routing requests before launch', async () => {
  let launches = 0;
  const bridge = makeBridge({ launch: async () => { launches++; }, stop: async () => {} });
  await assert.rejects(bridge.complete({ model: 'system', stream: false }), /Only non-streaming PCC/);
  await assert.rejects(bridge.complete({ model: 'pcc', stream: true }), /Only non-streaming PCC/);
  assert.equal(launches, 0);
  await bridge.dispose();
});

test('shell quoting keeps quotes and metacharacters literal', () => {
  assert.equal(shellQuote("a'b;$HOME`id`"), "'a'\\''b;$HOME`id`'");
});

test('Terminal identity parser rejects missing or unsafe window identities', () => {
  assert.deepEqual(parseTerminalSession('123\n/dev/ttys000\n'), { windowID: 123, tty: '/dev/ttys000' });
  for (const value of ['', '0\n/dev/ttys000', '123\nother', 'any\n/dev/ttys000']) {
    assert.throws(() => parseTerminalSession(value));
  }
});

test('only a valid Terminal process identity can authorize app termination', () => {
  const window = '123\n/dev/ttys000';
  assert.deepEqual(parseTerminalSession(window + '\n234'), { windowID: 123, tty: '/dev/ttys000', terminalPID: 234 });
  for (const pid of ['0', '1', '2147483648', 'other']) {
    assert.equal(parseTerminalSession(window + '\n' + pid).terminalPID, undefined);
  }
});

test('bridge starts lazily, uses PCC only, serializes probes, and cleans its private directory', async () => {
  let launches = 0;
  let stops = 0;
  let active = 0;
  let peak = 0;
  let owned;
  const bridge = makeBridge({
    launch: async (state) => { launches++; owned = state; },
    stop: async () => { stops++; },
    request: async (_socket, path, options) => {
      if (path === '/health') return { models: [{ name: 'pcc', available: true }] };
      assert.equal(options.body.model, 'pcc');
      assert.equal(options.body.stream, false);
      active++; peak = Math.max(peak, active);
      await delay(5);
      active--;
      const nonce = options.body.messages[0].content.match(/nonce ([\w-]+)\./)[1];
      return response(nonce);
    },
  });
  assert.equal(launches, 0);
  const results = await Promise.all([bridge.probe(), bridge.probe(), bridge.probe()]);
  assert.equal(launches, 1);
  assert.equal(peak, 1);
  assert.equal((await stat(owned.dir)).mode & 0o777, 0o700);
  assert(results.every((result) => result.ok && result.model === 'pcc'));
  await Promise.all([bridge.dispose(), bridge.dispose()]);
  assert.equal(stops, 1);
  await assert.rejects(access(owned.dir), { code: 'ENOENT' });
  await assert.rejects(bridge.probe(), /shut down/);
});

test('startup failure cleans up and permits a later explicit retry', async () => {
  let launches = 0;
  let stops = 0;
  const bridge = makeBridge({
    launch: async () => { if (++launches === 1) throw new Error('permission denied'); },
    stop: async () => { stops++; },
    request: async (_socket, path, options) => path === '/health'
      ? { models: [{ name: 'pcc', available: true }] }
      : response(options.body.messages[0].content.match(/nonce ([\w-]+)\./)[1]),
  });
  await assert.rejects(bridge.probe(), /permission denied/);
  assert.equal(stops, 1);
  assert.equal((await bridge.probe()).model, 'pcc');
  await bridge.dispose();
  assert.equal(stops, 2);
});

test('PCC unavailable or exhausted never falls back to system', async () => {
  for (const model of [{ name: 'pcc', available: false },
    { name: 'pcc', available: true, quota: { limit_reached: true } }]) {
    let inference = 0;
    const bridge = makeBridge({
      launch: async () => {}, stop: async () => {},
      request: async (_socket, path) => {
        if (path !== '/health') inference++;
        return { models: [model, { name: 'system', available: true }] };
      },
    });
    await assert.rejects(bridge.probe(), /PCC is unavailable/);
    assert.equal(inference, 0);
    await bridge.dispose();
  }
});

test('startup deadline fails instead of waiting indefinitely', async () => {
  const bridge = makeBridge({ launch: async () => {}, stop: async () => {}, startupMs: 0,
    request: async () => { throw new Error('no socket'); } });
  await assert.rejects(bridge.probe(), /Timed out waiting for the PCC server/);
  await bridge.dispose();
});

test('dispose cancels a pending PCC call before cleaning the server', async () => {
  let requestStarted;
  const ready = new Promise((resolve) => { requestStarted = resolve; });
  let stopped = false;
  const bridge = makeBridge({ launch: async () => {}, stop: async () => { stopped = true; },
    request: async (_socket, path, { signal }) => {
      if (path === '/health') return { models: [{ name: 'pcc', available: true }] };
      requestStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const pending = bridge.probe();
  const rejected = assert.rejects(pending, /shut down/);
  await ready;
  await bridge.dispose();
  await rejected;
  assert.equal(stopped, true);
});
