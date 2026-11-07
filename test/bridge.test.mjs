import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PCCBridge, validatePCCReply } from '../src/bridge.mjs';
import { createRoutingRequest } from '../src/routing.mjs';
import { parseTerminalSession, respondArguments, shellQuote } from '../src/terminal.mjs';

const catalog = [{ providerID: 'provider', id: 'model', routes: [{ route_id: 'route-1' }] }];
const chat = (sessionID, messageID, host = 'opencode') => ({ host, sessionID, messageID });
const input = (text, nonce, context = [], candidates = catalog) => createRoutingRequest({ text, nonce, context, catalog: candidates });

function evidence(transcript) {
  assert.equal(transcript.modelName, 'pcc');
  assert.equal(transcript.transcript.version, '1.1');
  const [instructions, ...entries] = transcript.transcript.transcript.entries;
  assert.equal(instructions.role, 'instructions');
  return entries.map(entry => JSON.parse(entry.contents[0].text));
}

function mockRespond(calls) {
  return async (transcript) => {
    const messages = evidence(transcript);
    calls.push(messages);
    const { nonce, catalog } = messages.at(-1);
    return { nonce, route_id: catalog[0].routes[0].route_id, reason: 'Suitable for this task.' };
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fm-pcc-session-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const bridge = new PCCBridge({ sessionRoot: root, respond: mockRespond(calls) });
  return { root, calls, bridge };
}

test('Terminal ownership parsing and command arguments only use identifiers, paths, and a fixed instruction', () => {
  assert.deepEqual(parseTerminalSession('123\n/dev/ttys000\n321\n'), {
    windowID: 123, tty: '/dev/ttys000', terminalPID: 321,
  });
  for (const value of ['', '0\n/dev/ttys000', '123\nother', 'any\n/dev/ttys000']) {
    assert.throws(() => parseTerminalSession(value));
  }
  assert.equal(parseTerminalSession('123\n/dev/ttys000\n2147483648').terminalPID, undefined);
  assert.equal(shellQuote("a'b;$HOME`id`"), "'a'\\''b;$HOME`id`'");
  assert.deepEqual(respondArguments('/tmp/input.json', '/tmp/schema.json').slice(0, -1), [
    'respond', '--model', 'pcc', '--no-stream', '--resume', '/tmp/input.json', '--schema', '/tmp/schema.json',
  ]);
});

test('OpenCode restores each chat from its own authoritative history, including after a rewind', async t => {
  const { bridge, calls, root } = await fixture(t);
  await bridge.complete(input('alpha', 'n1'), chat('a', '1'));
  await bridge.complete(input('bravo', 'n2'), chat('b', '1'));
  await bridge.complete(input('follow-up a', 'n3', [{ role: 'user', text: 'alpha' }]), chat('a', '2'));
  await bridge.complete(input('follow-up b', 'n4', [{ role: 'user', text: 'bravo' }]), chat('b', '2'));
  await bridge.complete(input('rewound a', 'n5'), chat('a', '3'));
  assert.deepEqual(calls[2][0].history, [{ role: 'user', text: 'alpha' }]);
  assert.deepEqual(calls[3][0].history, [{ role: 'user', text: 'bravo' }]);
  assert.equal(calls[4].length, 1);
  const state = await readdir(root);
  assert.equal(state.length, 2);
  for (const name of state) assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
});

test('Codex resumes only prior delegation tasks across bridge instances, with host-isolated IDs', async t => {
  const { bridge, calls, root } = await fixture(t);
  await bridge.complete(input('OpenCode only', 'n1'), chat('same', '1'));
  await bridge.complete(input('delegation A', 'n2'), chat('same', undefined, 'codex'));
  const next = new PCCBridge({ sessionRoot: root, respond: mockRespond(calls) });
  await next.complete(input('delegation B', 'n3'), chat('same', undefined, 'codex'));
  await next.complete(input('fresh codex chat', 'n4'), chat('new', undefined, 'codex'));
  assert.deepEqual(calls[2][0].history, [{ role: 'user', text: 'delegation A' }]);
  assert.equal(calls[3].length, 1);
  assert.doesNotMatch(JSON.stringify(calls[2]), /OpenCode only/);
});

test('only current validated routes advance state and duplicate messages reuse the decision', async t => {
  const { bridge, calls, root } = await fixture(t);
  await bridge.complete(input('task one', 'n1'), chat('a', '1'));
  const file = join(root, (await readdir(root))[0]);
  const first = await readFile(file, 'utf8');
  const cached = await bridge.complete(input('task one', 'n2'), chat('a', '1'));
  assert.equal(JSON.parse(cached.choices[0].message.content).nonce, 'n2');
  assert.equal(calls.length, 1);
  assert.equal(await readFile(file, 'utf8'), first);
  const bad = new PCCBridge({ sessionRoot: root, respond: async () => ({ nonce: 'wrong', route_id: 'route-1', reason: 'Invalid.' }) });
  await assert.rejects(bad.complete(input('rejected', 'n3'), chat('a', '2')), /Invalid PCC routing decision/);
  assert.equal(await readFile(file, 'utf8'), first);
  await bridge.complete(input('task two', 'n4'), chat('a', '2'));
  await assert.rejects(bridge.complete(input('task one', 'n5'), chat('a', '1')), /superseded/);
  assert.equal(calls.length, 2);
  await bridge.forget(chat('a'));
  assert.deepEqual(await readdir(root), []);
});

test('changes to the live catalog invalidate a cached decision for the same message', async t => {
  const { bridge, calls } = await fixture(t);
  await bridge.complete(input('task', 'n1'), chat('a', '1'));
  const candidates = [{ providerID: 'new', id: 'new', routes: [{ route_id: 'route-2' }] }];
  const reply = await bridge.complete(input('task', 'n2', [], candidates), chat('a', '1'));
  assert.equal(JSON.parse(reply.choices[0].message.content).route_id, 'route-2');
  assert.equal(calls.length, 2);
});

test('stateless calls and probes do not create chat records', async t => {
  const { root } = await fixture(t);
  const bridge = new PCCBridge({ sessionRoot: root, respond: async (transcript) => {
    const [{ nonce, catalog }] = evidence(transcript);
    return catalog ? { nonce, route_id: 'route-1', reason: 'Good fit.' } : { nonce, ok: true };
  } });
  assert.equal((await bridge.complete(input('task', 'n1'))).model, 'pcc');
  assert.equal((await bridge.probe()).ok, true);
  assert.deepEqual(await readdir(root), []);
  assert.throws(() => validatePCCReply({ model: 'system', choices: [] }, 'n1'), /did not complete/);
});

test('a relative session path fails before making a PCC request', async () => {
  const bridge = new PCCBridge({ sessionRoot: 'relative-session-path', respond: async () => {
    assert.fail('The bridge must not send a request for an invalid state path.');
  } });
  await assert.rejects(bridge.complete(input('task', 'n1'), chat('a', '1')), /must be an absolute path/);
});

test('Codex preserves the current routing input when older chat context exceeds the budget', async t => {
  const { bridge, calls } = await fixture(t);
  const identity = chat('budget', undefined, 'codex');
  await bridge.complete(input('p'.repeat(5_900), 'n1'), identity);
  const current = 'n'.repeat(18_000);
  await bridge.complete(input(current, 'n2'), identity);
  assert.equal(calls[1].length, 1);
  assert.equal(calls[1][0].text, current);
});

test('dispose aborts the current invocation and keeps queued work from launching', async () => {
  const started = new EventTarget();
  const ready = once(started, 'ready');
  let calls = 0;
  const bridge = new PCCBridge({ respond: async (_transcript, _schema, signal) => {
    calls++;
    started.dispatchEvent(new Event('ready'));
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const first = assert.rejects(bridge.complete(input('first', 'n1')), /shut down/);
  const second = assert.rejects(bridge.complete(input('second', 'n2')), /shut down/);
  await ready;
  await bridge.dispose();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
