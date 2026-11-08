import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRoutingRequest, parseRoutingResponse } from '../src/routing.mjs';
import { routingFingerprint } from '../src/session.mjs';
import { RoutingStrategies } from '../src/strategies.mjs';

const identity = { host: 'opencode', sessionID: 'a' };
const custom = { fast: 'Prefer lower latency.', review: 'Prefer thorough reasoning.' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fm-pcc-strategy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'strategies.json');
  const selectionRoot = join(root, 'selections');
  return { file, selectionRoot, strategies: new RoutingStrategies({ file, selectionRoot }) };
}

test('default works without a file and chat choices persist separately from transcript expiry', async t => {
  const { file, selectionRoot, strategies } = await fixture(t);
  assert.deepEqual(await strategies.list(), ['default']);
  assert.deepEqual(await strategies.current(), { id: 'default' });
  assert.deepEqual(await strategies.current(identity), { id: 'default' });
  await writeFile(file, JSON.stringify(custom));
  assert.deepEqual(await strategies.list(), ['default', 'fast', 'review']);
  await strategies.select(identity, 'review');
  const [selection] = await readdir(selectionRoot);
  const selected = join(selectionRoot, selection);
  assert.equal((await stat(selected)).mode & 0o777, 0o600);
  await utimes(selected, 1, 1);
  const reopened = new RoutingStrategies({ file, selectionRoot });
  assert.deepEqual(await reopened.current(identity), { id: 'review', instructions: custom.review });
  assert.equal((await reopened.current({ ...identity, host: 'codex' })).id, 'default');
  assert.equal((await reopened.current({ ...identity, sessionID: 'b' })).id, 'default');
  await reopened.select(identity, 'default');
  assert.deepEqual(await readdir(selectionRoot), []);
});

test('unknown or removed strategies surface errors and a reset works with a malformed config', async t => {
  const { file, strategies } = await fixture(t);
  await writeFile(file, JSON.stringify(custom));
  await strategies.select(identity, 'fast');
  await assert.rejects(strategies.select(identity, 'missing'), /Unknown routing strategy/);
  assert.equal((await strategies.current(identity)).id, 'fast');
  await writeFile(file, JSON.stringify({ review: custom.review }));
  await assert.rejects(strategies.current(identity), /selected routing strategy is missing/);
  await writeFile(file, '{');
  await assert.rejects(strategies.list(), /invalid JSON/);
  await strategies.select(identity, 'default');
  assert.equal((await strategies.current(identity)).id, 'default');
});

test('config validation protects the reserved name, instruction size, and file permissions', async t => {
  const { file, strategies } = await fixture(t);
  for (const config of [{ default: 'Override' }, { 'invalid name': 'Text' }, { fast: '' }, { fast: '길'.repeat(700) }]) {
    await writeFile(file, JSON.stringify(config));
    await assert.rejects(strategies.list(), /reserve the name default|Invalid custom routing strategy/);
  }
  await writeFile(file, JSON.stringify(custom));
  await chmod(file, 0o666);
  await assert.rejects(strategies.list(), /protected from writes by others/);
});

test('strategy edits change the request fingerprint without widening the validated catalog', async t => {
  const { file, strategies } = await fixture(t);
  const catalog = [{ providerID: 'allowed', id: 'model', routes: [{ route_id: 'r1' }] }];
  const input = { text: 'Check this diff.', catalog, nonce: 'nonce' };
  const make = async () => createRoutingRequest({ ...input, strategy: await strategies.current(identity) });
  assert.deepEqual(await make(), createRoutingRequest(input));
  await writeFile(file, JSON.stringify(custom));
  await strategies.select(identity, 'review');
  const before = await make();
  assert.match(before.messages[0].content, /Prefer thorough reasoning/);
  assert.doesNotMatch(before.messages[0].content, /Prefer lower latency/);
  const fingerprint = body => routingFingerprint(body.messages[0].content, JSON.parse(body.messages[1].content),
    body.response_format.json_schema.schema);
  await writeFile(file, JSON.stringify({ ...custom, review: 'Prefer depth and use provider X.' }));
  const after = await make();
  assert.notEqual(fingerprint(before), fingerprint(after));
  assert.deepEqual(before.messages[1], after.messages[1]);
  assert.throws(() => parseRoutingResponse({ model: 'pcc', choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify({ nonce: 'nonce', route_id: 'unlisted', reason: 'Suggested' }) } }] }, catalog, 'nonce'),
  /unavailable route/);
});
