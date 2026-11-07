import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbePlugin } from '../integrations/opencode/plugin.mjs';

function mockContext() {
  const commands = [];
  const messages = [];
  const registrations = [];
  return { commands, messages, registrations,
    context: {
      options: { enabled: false },
      command: { transform: async (edit) => {
        edit({ add: (definition) => commands.push(definition) });
        const registration = { disposed: false, async dispose() { this.disposed = true; } };
        registrations.push(registration);
        return registration;
      } },
      session: { synthetic: async (message) => { messages.push(message); } },
    },
  };
}

test('plugin only registers its explicit test command and does not call PCC during setup', async () => {
  const mock = mockContext();
  let calls = 0;
  let disposed = false;
  const plugin = createProbePlugin(() => ({
    probe: async () => { calls++; return { model: 'pcc', ok: true, elapsedMs: 12 }; },
    dispose: async () => { disposed = true; },
  }));
  const cleanup = await plugin.setup(mock.context);
  assert.equal(calls, 0);
  assert.equal(mock.commands.length, 1);
  assert.equal(mock.commands[0].name, 'pcc-test');
  await mock.commands[0].execute({ sessionID: 'same-chat' });
  assert.equal(calls, 1);
  assert.match(mock.messages[0].text, /PCC 연결 성공/);
  assert.match(mock.messages[0].description, /model=pcc/);
  assert.match(mock.messages[0].description, /12ms/);
  assert.doesNotMatch(mock.messages[0].description, /\n/);
  assert.equal(mock.messages[0].sessionID, 'same-chat');
  assert.equal(mock.messages[0].resume, false);
  assert.equal(mock.messages[0].delivery, 'queue');
  await cleanup();
  assert(disposed && mock.registrations[0].disposed);
});

test('failed probe produces failure in the same chat without resuming the model', async () => {
  const mock = mockContext();
  const plugin = createProbePlugin(() => ({ probe: async () => { throw new Error('permission denied'); }, dispose: async () => {} }));
  const cleanup = await plugin.setup(mock.context);
  await mock.commands[0].execute({ sessionID: 'same-chat' });
  assert.match(mock.messages[0].text, /PCC probe failed/);
  assert.match(mock.messages[0].text, /permission denied/);
  assert.match(mock.messages[0].description, /PCC probe failed.*permission denied/);
  assert.doesNotMatch(mock.messages[0].description, /\n/);
  assert.equal(mock.messages[0].resume, false);
  await cleanup();
});

test('non-Error probe failures use an English fallback', async () => {
  const mock = mockContext();
  const plugin = createProbePlugin(() => ({ probe: async () => { throw 'failure'; }, dispose: async () => {} }));
  const cleanup = await plugin.setup(mock.context);
  await mock.commands[0].execute({ sessionID: 'same-chat' });
  assert.match(mock.messages[0].text, /PCC probe failed/);
  assert.match(mock.messages[0].text, /Unknown error/);
  assert.match(mock.messages[0].description, /PCC probe failed.*Unknown error/);
  await cleanup();
});

test('registration failure releases the bridge', async () => {
  let disposed = false;
  const plugin = createProbePlugin(() => ({ dispose: async () => { disposed = true; } }));
  await assert.rejects(plugin.setup({ command: { transform: async () => { throw new Error('registration'); } }, session: { synthetic() {} } }), /registration/);
  assert(disposed);
});

test('incompatible clients fail before constructing a bridge', async () => {
  let constructed = false;
  await assert.rejects(createProbePlugin(() => { constructed = true; }).setup({}), /OpenCode/);
  assert.equal(constructed, false);
});
