import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { connectedScope, registerAutomaticRouter, requiredInputs, routingContext, validateOptions } from '../integrations/opencode/automatic.mjs';

const model = (providerID, id = 'model') => ({ providerID, id, type: 'chat', name: id,
  enabled: true, capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'] },
  limit: { context: 64_000, input: 60_000, output: 4096 }, variants: [{ id: 'deep' }], cost: [] });

function fixture(options = {}) {
  const hooks = new Map();
  const events = new EventEmitter();
  const connections = new Set(['contract']);
  const models = [model('automatic-free'), model('contract')];
  const providers = [{ id: 'automatic-free', integrationID: 'free-account' }, { id: 'contract', integrationID: 'contract' }];
  const session = { id: 's', location: { directory: '/test' }, time: {}, model: { providerID: 'contract', id: 'model' }, metadata: { existing: true } };
  const calls = { pcc: [], switches: [], notices: [] };
  const ctx = {
    provider: { list: async () => ({ data: providers }) },
    integration: { connection: { active: async (id) => connections.has(id) ? { type: 'credential', id: 'metadata-only' } : undefined,
      resolve: () => { throw new Error('Secrets must never be resolved'); } } },
    model: { list: async () => ({ data: models }) },
    session: {
      get: async () => structuredClone(session), context: async () => [],
      switchModel: async ({ model }) => { calls.switches.push(model); session.model = options.readbackDefault
        && model.variant === undefined ? { ...model, variant: 'default' } : model; },
      update: async ({ metadata }) => { session.metadata = metadata; },
      synthetic: async (notice) => { calls.notices.push(notice); },
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) }; },
    },
    event: { async *subscribe({ signal }) {
      try { for await (const [event] of on(events, 'event', { signal })) yield event; }
      catch (error) { if (!signal.aborted) throw error; }
    } },
  };
  const bridge = { complete: async (body) => {
    calls.pcc.push(body);
    const input = JSON.parse(body.messages[1].content);
    const choice = options.defaultRoute ? input.catalog[0].routes[0].route_id : input.catalog.at(-1).routes.at(-1).route_id;
    options.beforeReply?.();
    return { model: 'pcc', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      nonce: input.nonce, route_id: choice, reason: 'Fits the current task.' }) } }] };
  } };
  const prompt = (id = 'm1') => ({ sessionID: 's', messageID: id, prompt: { text: 'Explain a simple function.' }, metadata: { untouched: true } });
  return { ctx, hooks, events, connections, models, providers, session, calls, bridge, prompt };
}

test('routes before admission using connected providers and preserves exact variant and user text', async () => {
  const f = fixture();
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    const event = f.prompt();
    await f.hooks.get('prompt')(event);
    assert.deepEqual(f.session.model, { providerID: 'contract', id: 'model', variant: 'deep' });
    assert.deepEqual(f.calls.pcc.map((body) => JSON.parse(body.messages[1].content).catalog.map((m) => m.providerID)), [['contract']]);
    assert.equal(event.prompt.text, 'Explain a simple function.');
    assert(event.metadata.untouched && f.session.metadata.existing);
    assert.equal(event.metadata.foundationRouter.model.variant, 'deep');
    await f.hooks.get('model.request')({ sessionID: 's', kind: 'primary', model: f.session.model });
    const title = { sessionID: 's' };
    f.hooks.get('title')(title);
    assert.equal(title.result, event.prompt.text);
    await assert.rejects(f.hooks.get('prompt')(f.prompt('m2')), /already pending/);
  } finally { await cleanup(); }
});

test('default variant readback is accepted through prompt admission and inference guard', async () => {
  const f = fixture({ readbackDefault: true, defaultRoute: true });
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    const event = f.prompt();
    await f.hooks.get('prompt')(event);
    assert.deepEqual(f.session.model, { providerID: 'contract', id: 'model', variant: 'default' });
    assert.equal(event.metadata.foundationRouter.model.variant, undefined);
    await f.hooks.get('model.request')({ sessionID: 's', kind: 'primary', model: f.session.model });
  } finally { await cleanup(); }
});

test('provider additions are considered on the next idle request without a code change', async () => {
  const f = fixture();
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await f.hooks.get('prompt')(f.prompt());
    f.events.emit('event', { type: 'session.execution.succeeded', data: { sessionID: 's' } });
    await nextTick();
    f.providers.push({ id: 'new-provider', integrationID: 'new-provider' });
    f.connections.add('new-provider');
    f.models.push(model('new-provider', 'new-model'));
    await f.hooks.get('prompt')(f.prompt('m2'));
    assert.equal(f.session.model.providerID, 'new-provider');
    assert.equal(f.calls.pcc.length, 2);
  } finally { await cleanup(); }
});

test('an explicit provider allowlist is a hard boundary and an empty list never falls back', async () => {
  const f = fixture();
  f.connections.add('free-account');
  assert.deepEqual(await connectedScope(f.ctx, f.session.location, ['contract']), ['contract']);
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge, { allowedProviders: [] });
  try {
    await assert.rejects(f.hooks.get('prompt')(f.prompt()), /No eligible/);
    assert.equal(f.calls.pcc.length, 0);
    assert.equal(f.calls.switches.length, 0);
  } finally { await cleanup(); }
});

test('disconnecting during PCC selection rejects the result before switching', async () => {
  const f = fixture({ beforeReply: () => f.connections.delete('contract') });
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await assert.rejects(f.hooks.get('prompt')(f.prompt()), /no longer connected/);
    assert.equal(f.calls.switches.length, 0);
  } finally { await cleanup(); }
});

test('inference guard blocks other providers, executor mismatches and removed connections', async () => {
  const f = fixture();
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await f.hooks.get('prompt')(f.prompt());
    const guard = f.hooks.get('model.request');
    for (const kind of ['primary', 'compaction', 'generate', 'title']) {
      await assert.rejects(guard({ sessionID: 's', kind, model: { providerID: 'automatic-free', id: 'model' } }), /allowlist/);
    }
    await assert.rejects(guard({ sessionID: 's', kind: 'primary', model: { providerID: 'contract', id: 'invented' } }), /validated PCC route/);
    await assert.rejects(guard({ sessionID: 's', kind: 'primary', model: { providerID: 'contract', id: 'model', variant: 'other' } }), /validated PCC route/);
    f.connections.add('free-account');
    await assert.rejects(guard({ sessionID: 's', kind: 'primary', model: { providerID: 'automatic-free', id: 'model', variant: 'deep' } }), /validated PCC route/);
    f.models[1].enabled = false;
    await assert.rejects(guard({ sessionID: 's', kind: 'primary', model: f.session.model }), /no longer available/);
    f.models[1].enabled = true;
    f.connections.delete('contract');
    await assert.rejects(guard({ sessionID: 's', kind: 'primary', model: f.session.model }), /allowlist/);
  } finally { await cleanup(); }
});

test('cancelling the reserved inbox item permits a new routing decision', async () => {
  const f = fixture();
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await f.hooks.get('prompt')(f.prompt());
    f.events.emit('event', { type: 'session.inbox.cancelled', data: { sessionID: 's', inboxID: 'different' } });
    await nextTick();
    await assert.rejects(f.hooks.get('prompt')(f.prompt('m2')), /already pending/);
    f.events.emit('event', { type: 'session.inbox.cancelled', data: { sessionID: 's', inboxID: 'm1' } });
    await nextTick();
    await f.hooks.get('prompt')(f.prompt('m2'));
    assert.equal(f.calls.pcc.length, 2);
  } finally { await cleanup(); }
});

test('steering an active task does not switch its model or call PCC again', async () => {
  const f = fixture();
  f.session.time.busy = 123;
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await f.hooks.get('prompt')(f.prompt());
    assert.equal(f.calls.pcc.length, 0);
  } finally { await cleanup(); }
});

test('a historical busy timestamp does not prevent routing after the chat becomes idle', async () => {
  const f = fixture();
  f.session.time = { busy: 123, idle: 456 };
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await f.hooks.get('prompt')(f.prompt());
    assert.equal(f.calls.pcc.length, 1);
    assert.equal(f.calls.switches.length, 1);
  } finally { await cleanup(); }
});

test('PCC failure never starts a model and permits a later retry', async () => {
  const f = fixture();
  let fail = true;
  const complete = f.bridge.complete;
  f.bridge.complete = async (body) => { if (fail) throw new Error('PCC unavailable'); return complete(body); };
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    await assert.rejects(f.hooks.get('prompt')(f.prompt()), /PCC unavailable/);
    assert.equal(f.calls.switches.length, 0);
    assert.match(f.calls.notices[0].description, /PCC routing failed: PCC unavailable/);
    assert.equal(f.calls.notices[0].resume, false);
    fail = false;
    await f.hooks.get('prompt')(f.prompt());
    assert.equal(f.calls.switches.length, 1);
  } finally { await cleanup(); }
});

test('oversized current requests fail without truncation or a PCC call', async () => {
  const f = fixture();
  const cleanup = await registerAutomaticRouter(f.ctx, f.bridge);
  try {
    const event = f.prompt();
    event.prompt.text = 'a'.repeat(30_000);
    await assert.rejects(f.hooks.get('prompt')(event), /safe context budget/);
    assert.equal(event.prompt.text.length, 30_000);
    assert.equal(f.calls.pcc.length, 0);
    assert.equal(f.calls.switches.length, 0);
  } finally { await cleanup(); }
});

test('attachment modalities and bounded history exclude tool output and reasoning', () => {
  assert.deepEqual(requiredInputs([{ name: 'a.PNG' }, { mime: 'application/pdf' }]), ['text', 'image', 'pdf']);
  assert.deepEqual(routingContext([{ type: 'user', text: 'prior' },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'SECRET' }, { type: 'tool', text: 'SECRET' }, { type: 'text', text: 'answer' }] }]),
  [{ role: 'user', text: 'prior' }, { role: 'assistant', text: 'answer' }]);
  assert.throws(() => validateOptions({ allowedProviders: 'provider' }));
  assert.throws(() => validateOptions({ preference: 'invented' }));
});
