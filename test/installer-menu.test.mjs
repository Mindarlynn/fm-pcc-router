import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { chooseTargets } from '../installer-menu.mjs';

const rows = [{ id: 'opencode', label: 'OpenCode' }, { id: 'codex', label: 'Codex', status: 'Installed' }];

function menu(options = rows, action = 'Install') {
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false, setRawMode(raw) { this.isRaw = raw; },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let screen = '';
  output.on('data', chunk => { screen += chunk; });
  const result = chooseTargets(options, action, { input, output });
  const key = (name, ctrl = false) => input.emit('keypress', '', { name, ctrl });
  return { input, key, result, screen: () => screen };
}

test('the menu starts empty and selects multiple targets in display order', async () => {
  const f = menu();
  assert.match(f.screen(), /> \[ \] OpenCode/);
  assert.match(f.screen(), /Codex \(Installed\)/);
  assert.equal(f.input.isRaw, true);
  f.key('return');
  assert.match(f.screen(), /Select at least one app/);
  f.key('down');
  f.key('space');
  f.key('up');
  f.key('space');
  f.key('return');
  assert.deepEqual(await f.result, ['opencode', 'codex']);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.listenerCount('keypress'), 0);
});

test('disabled targets are skipped and checked targets can be toggled off', async () => {
  const f = menu([{ ...rows[0], disabled: true }, rows[1]], 'Uninstall');
  assert.match(f.screen(), /> \[ \] Codex/);
  assert.match(f.screen(), /Enter Uninstall/);
  f.key('space');
  f.key('space');
  f.key('return');
  assert.match(f.screen(), /Select at least one app/);
  f.key('up');
  f.key('space');
  f.key('return');
  assert.deepEqual(await f.result, ['codex']);
});

test('Escape, Ctrl+C, and input errors restore the terminal before returning', async () => {
  for (const [name, ctrl] of [['escape', false], ['c', true]]) {
    const f = menu();
    f.key('space');
    f.key(name, ctrl);
    assert.deepEqual(await f.result, []);
    assert.equal(f.input.isRaw, false);
  }
  const f = menu();
  f.input.emit('error', new Error('Closed input.'));
  await assert.rejects(f.result, /Closed input/);
  assert.equal(f.input.isRaw, false);
});
