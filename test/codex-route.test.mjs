import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chooseCodexRoute, getCodexCatalog, mapCodexModels, validateTask } from '../integrations/codex/codex-route.mjs';

import { RoutingStrategies } from '../src/strategies.mjs';

const defaultStrategies = { current: async () => ({ id: 'default' }) };

const modelData = (id = 'gpt-example') => ({
  id, displayName: 'Example Codex', contextWindow: 128000,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'low',
});

test('task input must be nonempty and fit the UTF-8 byte bound', () => {
  assert.equal(validateTask('do the task'), 'do the task');
  assert.throws(() => validateTask('  '), /must not be empty/);
  assert.throws(() => validateTask('あ'.repeat(9000)), /24 KB/);
});

test('Codex catalog mapping exposes only listed model IDs and supported effort choices', () => {
  const mapped = mapCodexModels([
    { ...modelData(), supportedReasoningEfforts: ['low', 'high', 'ultra', 'unknown'] },
    { ...modelData('hidden'), hidden: true },
    { ...modelData('no-supported-effort'), supportedReasoningEfforts: ['none'] },
  ]);
  assert.equal(mapped.length, 1);
  assert.deepEqual(mapped[0].variants, [{ id: 'low' }, { id: 'high' }]);
  assert.equal(mapped[0].limit.context, 128000);
  assert.equal(mapped[0].capabilities.tools, false);
  assert.throws(() => mapCodexModels({ data: [] }), /invalid model catalog/);
  assert.throws(() => mapCodexModels([modelData(), modelData()]), /duplicate model/);
  assert.throws(() => mapCodexModels([{ ...modelData(), supportedReasoningEfforts: {} }]), /reasoning effort/);
});

test('selected route is validated and returns the model ID plus supported effort', async () => {
  const model = mapCodexModels([modelData()])[0];
  let sent;
  const result = await chooseCodexRoute('A complex task', {
    strategies: defaultStrategies,
    getModels: async () => [model],
    bridge: { complete: async body => {
      sent = body;
      const catalog = JSON.parse(body.messages[1].content).catalog;
      const route = catalog[0].routes.find(entry => entry.variant === 'high');
      return { model: 'pcc', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        nonce: JSON.parse(body.messages[1].content).nonce, route_id: route.route_id, reason: 'Higher reasoning fits this task.',
      }) } }] };
    } },
  });
  assert.equal(result.model, 'gpt-example');
  assert.equal(result.effort, 'high');
  assert.equal(typeof result.reason, 'string');
  assert.equal(JSON.parse(sent.messages[1].content).catalog[0].providerID, 'codex');
  await assert.rejects(chooseCodexRoute('task', {
    strategies: defaultStrategies,
    getModels: async () => [model], bridge: { complete: async () => ({ model: 'pcc', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ nonce: 'wrong', route_id: 'r1', reason: 'x' }) } }] }) },
  }), /routing decision/);
  const defaultResult = await chooseCodexRoute('routine task', {
    strategies: defaultStrategies,
    getModels: async () => [model],
    bridge: { complete: async body => {
      const payload = JSON.parse(body.messages[1].content);
      assert.ok(payload.catalog[0].routes.every(route => route.variant));
      const route = payload.catalog[0].routes.find(entry => entry.variant === 'low');
      return { model: 'pcc', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        nonce: payload.nonce, route_id: route.route_id, reason: 'Use the model default effort.',
      }) } }] };
    } },
  });
  assert.equal(defaultResult.effort, 'low');
});

const routeScript = fileURLToPath(new URL('../integrations/codex/codex-route.mjs', import.meta.url));

function strategyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pcc-codex-strategy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const state = join(root, 'state');
  const instruction = 'Prefer lower reasoning effort for simple delegation.';
  mkdirSync(join(config, 'fm-pcc-router'), { recursive: true });
  writeFileSync(join(config, 'fm-pcc-router', 'strategies.json'), JSON.stringify({ fast: instruction }), { mode: 0o600 });
  const hook = (event) => {
    const result = spawnSync(process.execPath, [routeScript, '--user-prompt-submit'], {
      input: typeof event === 'string' ? event : JSON.stringify(event),
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, CODEX_THREAD_ID: 'ignored-env-id' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  return { config, state, instruction, hook };
}

const promptEvent = (prompt, session_id) => ({ hook_event_name: 'UserPromptSubmit', prompt, session_id });

test('Codex hook emits only fixed guidance and never processes chat management commands', (t) => {
  const { hook, state } = strategyFixture(t);
  const ordinary = hook(promptEvent('Ordinary private prompt.', 'first'));
  assert.deepEqual(Object.keys(ordinary), ['hookSpecificOutput']);
  assert.equal(ordinary.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ordinary.hookSpecificOutput.additionalContext, /only if you are already going to create a native subagent/);
  assert.match(ordinary.hookSpecificOutput.additionalContext, /Pass only the delegated task description/);
  assert.doesNotMatch(JSON.stringify(ordinary), /Ordinary private prompt/);
  for (const event of [
    'pcc strategy use fast',
    promptEvent('pcc strategy list', 'first'),
    promptEvent('pcc strategy current', 'first'),
    promptEvent('pcc strategy use fast', 'first'),
    promptEvent('pcc strategy use missing', 'first'),
    { ...promptEvent('pcc strategy use fast', 'first'), hook_event_name: 'Stop' },
    promptEvent('Please explain pcc strategy use fast', 'first'),
    promptEvent('`pcc strategy use fast`', 'first'),
    promptEvent('pcc strategy use fast\n', 'first'),
    promptEvent('pcc strategy use fast\nDo another task.', 'first'),
    promptEvent('pcc strategy use fast ' + 'x'.repeat(64 * 1024), 'first'),
  ]) assert.deepEqual(hook(event), ordinary);
  assert.equal(existsSync(state), false);
});

test('the Codex thread ID scopes routing locally and a missing ID leaves routing stateless', async (t) => {
  const { config, state, instruction } = strategyFixture(t);
  const before = Object.fromEntries(['CODEX_THREAD_ID', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].map(key => [key, process.env[key]]));
  try {
    process.env.XDG_CONFIG_HOME = config;
    process.env.XDG_STATE_HOME = state;
    await new RoutingStrategies().select({ host: 'codex', sessionID: 'thread-fixture-123' }, 'fast');
    for (const sessionID of ['thread-fixture-123', 'another-thread', undefined, '']) {
      if (sessionID === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = sessionID;
      await chooseCodexRoute('Delegate this task.', {
        getModels: async () => mapCodexModels([modelData()]),
        bridge: { complete: async (body, ...identities) => {
          assert.deepEqual(identities, sessionID ? [{ host: 'codex', sessionID }] : []);
          if (sessionID) assert(!JSON.stringify(body).includes(sessionID));
          assert.equal(body.messages[0].content.includes(instruction), sessionID === 'thread-fixture-123');
          const { text, context, nonce, catalog } = JSON.parse(body.messages[1].content);
          assert.equal(text, 'Delegate this task.');
          assert.equal(context, '');
          return { model: 'pcc', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            nonce, route_id: catalog[0].routes[0].route_id, reason: 'Fits the delegated task.',
          }) } }] };
        } },
      });
    }
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('routing stops before calling PCC when no explicit subagent effort is available', async () => {
  const models = mapCodexModels([{ ...modelData(), supportedReasoningEfforts: [] }]);
  await assert.rejects(chooseCodexRoute('task', {
    strategies: defaultStrategies,
    getModels: async () => models,
    bridge: { complete: async () => assert.fail('PCC must not be called without a usable pair') },
  }), /No Codex model and reasoning effort pairs/);
});

function fakeCodexChild(pages) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = signal => {
    child.killed = true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 0;
    queueMicrotask(() => { child.emit('close', child.exitCode, signal); child.stdout.end(); });
    return true;
  };
  let pageIndex = 0;
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (!('id' in message)) continue;
      let result = {};
      if (message.method === 'model/list') result = pages[pageIndex++];
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });
  return child;
}

test('app-server initializes, reads every picker catalog page, and always cleans up child', async () => {
  let child;
  let args;
  const catalog = await getCodexCatalog({
    executable: '/test/codex', timeoutMs: 1000,
    spawn: (executable, argv, options) => {
      args = { executable, argv, options };
      child = fakeCodexChild([
        { data: [modelData()], nextCursor: 'next' },
        { data: [modelData('gpt-second')], nextCursor: null },
      ]);
      return child;
    },
  });
  assert.equal(args.executable, '/test/codex');
  assert.deepEqual(args.argv, ['app-server']);
  assert.deepEqual(catalog.map(model => model.id), ['gpt-example', 'gpt-second']);
  assert.equal(child.exitCode, 0);
  assert.equal(child.killed, true);
});

test('app-server rejects malformed protocol and stops its child', async () => {
  let child;
  await assert.rejects(getCodexCatalog({ executable: 'codex', timeoutMs: 1000, spawn: () => {
    child = fakeCodexChild([]);
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', () => child.stdout.write('not json\n'));
    return child;
  } }), /malformed protocol/);
  assert.equal(child.killed, true);
});
