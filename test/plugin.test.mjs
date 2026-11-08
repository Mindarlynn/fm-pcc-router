import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodePlugin } from '../integrations/opencode/plugin.mjs';

function mockContext(enabled = false) {
  const hooks = new Map();
  const calls = [];
  return { hooks, calls,
    context: {
      options: { enabled },
      event: { async *subscribe() {} },
      command: { transform: async () => { calls.push('command'); } },
      session: {
        synthetic: async () => { calls.push('synthetic'); },
        prompt: async () => { calls.push('prompt'); },
        hook: async (name, callback) => {
          hooks.set(name, callback);
          return { dispose: async () => hooks.delete(name) };
        },
      },
    },
  };
}

test('plugin preserves its ID and automatic hooks without chat controls or setup PCC calls', async () => {
  const mock = mockContext(true);
  let disposed = false;
  const plugin = createOpenCodePlugin(() => ({
    probe: async () => { mock.calls.push('probe'); },
    complete: async () => { mock.calls.push('complete'); },
    dispose: async () => { disposed = true; },
  }));
  assert.equal(plugin.id, 'foundation-pcc-probe');
  const cleanup = await plugin.setup(mock.context);
  assert.deepEqual([...mock.hooks.keys()], ['prompt', 'model.request', 'title']);
  assert.deepEqual(mock.calls, []);
  await cleanup();
  assert.equal(mock.hooks.size, 0);
  assert.equal(disposed, true);
});

test('disabled plugin works without command or synthetic APIs and adds no prompt hooks', async () => {
  const mock = mockContext();
  delete mock.context.command;
  delete mock.context.session;
  let disposed = false;
  const cleanup = await createOpenCodePlugin(() => ({ dispose: async () => { disposed = true; } })).setup(mock.context);
  assert.equal(mock.hooks.size, 0);
  await cleanup();
  assert.equal(disposed, true);
});

test('registration failure releases the bridge', async () => {
  const mock = mockContext(true);
  let disposed = false;
  mock.context.session.hook = async () => { throw new Error('registration'); };
  const plugin = createOpenCodePlugin(() => ({ dispose: async () => { disposed = true; } }));
  await assert.rejects(plugin.setup(mock.context), /registration/);
  assert.equal(disposed, true);
});

test('incompatible clients fail before constructing a bridge', async () => {
  let constructed = false;
  await assert.rejects(createOpenCodePlugin(() => { constructed = true; }).setup({}), /OpenCode/);
  assert.equal(constructed, false);
});
