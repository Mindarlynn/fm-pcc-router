import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCLI } from '../src/cli.mjs';
import { PCCBridge } from '../src/bridge.mjs';
import { RoutingStrategies } from '../src/strategies.mjs';

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const threadID = '00000000-0000-7000-8000-000000000001';
const sessionID = 'ses_abcdef012345AaBb0123456789';
const codex = `codex://threads/${threadID}`;
const opencode = `opencode:${sessionID}`;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'fm-pcc-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config/fm-pcc-router');
  const state = join(root, 'state');
  const file = join(config, 'strategies.json');
  await mkdir(config, { recursive: true });
  await writeFile(file, JSON.stringify({ quick: 'Prefer speed.', careful: 'Prefer accuracy.' }), { mode: 0o600 });
  const executable = join(root, 'fm-pcc-router');
  await symlink(entry, executable);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: state, CODEX_THREAD_ID: threadID };
  return {
    run: (...args) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', env }),
    strategies: new RoutingStrategies({ file, selectionRoot: join(state, 'fm-pcc-router/strategy-selections') }),
  };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim();
}

function failure(result, message) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}

test('the symlinked CLI lists names and shares persistent selections with both hosts', async (t) => {
  const { run, strategies } = await sandbox(t);
  const codexIdentity = { host: 'codex', sessionID: threadID };
  const opencodeIdentity = { host: 'opencode', sessionID };
  assert.match(success(run('--help')), /strategy current --chat <ref>/);
  assert.equal(success(run('strategy', 'list')), 'Available PCC strategies: default, quick, careful');
  assert.equal(success(run('strategy', 'current', '--chat', codex)), 'Current PCC strategy: default');
  await strategies.select(opencodeIdentity, 'careful');
  assert.equal(success(run('strategy', 'current', '--chat', opencode)), 'Current PCC strategy: careful');
  assert.equal(success(run('strategy', 'use', 'quick', '--chat', codex)), 'Selected PCC strategy: quick');
  assert.equal((await strategies.current(codexIdentity)).id, 'quick');
  assert.equal((await strategies.current(opencodeIdentity)).id, 'careful');
  failure(run('strategy', 'use', 'unknown', '--chat', codex), /Unknown routing strategy/);
  assert.equal(success(run('strategy', 'current', '--chat', codex)), 'Current PCC strategy: quick');
  assert.equal(success(run('strategy', 'use', 'default', '--chat', codex)), 'Selected PCC strategy: default');
  assert.equal((await strategies.current(codexIdentity)).id, 'default');
});

test('explicit references are required and malformed refs or extra arguments do not select a strategy', async (t) => {
  const { run, strategies } = await sandbox(t);
  failure(run('strategy', 'use', 'quick'), /Usage/);
  failure(run('strategy', 'current'), /Usage/);
  failure(run('strategy', 'list', '--chat', codex), /Usage/);
  failure(run('strategy', 'use', 'quick', '--chat', codex, '--chat', opencode), /Usage/);
  failure(run('test', '--chat', codex), /Usage/);
  for (const ref of [threadID, 'codex://threads/invalid', `${codex}?extra=1`, `${codex}\n`,
    sessionID, 'opencode:ses_short', `opencode:${sessionID}/extra`]) {
    failure(run('strategy', 'use', 'quick', '--chat', ref), /Invalid chat reference/);
  }
  assert.equal((await strategies.current({ host: 'codex', sessionID: threadID })).id, 'default');
  assert.equal((await strategies.current({ host: 'opencode', sessionID })).id, 'default');
});

test('the connectivity command uses the probe and disposes the bridge on success and failure', async () => {
  for (const valid of [true, false]) {
    let probes = 0;
    let disposals = 0;
    const bridge = new PCCBridge({
      async respond(input) {
        probes++;
        const entries = input.transcript.transcript.entries;
        assert.equal(entries.length, 2);
        const probe = JSON.parse(entries[1].contents[0].text);
        assert.deepEqual(Object.keys(probe).sort(), ['nonce', 'ok']);
        return valid ? probe : { ...probe, nonce: 'mismatch' };
      },
    });
    const result = runCLI(['test'], { makeBridge: () => ({
      probe: () => bridge.probe(),
      dispose: async () => {
        await bridge.dispose();
        disposals++;
      },
    }) });
    if (valid) assert.match(await result, /PCC connection succeeded \(model=pcc, \d+ms\)/);
    else await assert.rejects(result, /does not match the current request/);
    assert.equal(probes, 1);
    assert.equal(disposals, 1);
  }
});
