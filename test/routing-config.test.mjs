import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRoutingConfig } from '../src/routing-config.mjs';

test('candidate configuration is optional, scoped to the host, and validated in full', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fm-pcc-candidate-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'fm-pcc-router');
  await mkdir(directory);
  const path = join(directory, 'routing.json');
  const env = { XDG_CONFIG_HOME: root };
  assert.deepEqual(readRoutingConfig('opencode', env), {});
  const opencode = { models: [{ providerID: 'contract', id: 'model' }], maxModelsPerProvider: 2 };
  await writeFile(path, JSON.stringify({ hosts: { opencode } }));
  assert.deepEqual(readRoutingConfig('opencode', env), opencode);
  assert.deepEqual(readRoutingConfig('codex', env), {});

  for (const codex of [{ models: 'all' }, { maxModelsPerProvider: 0 }, { models: [{}] }, { maxModels: 5 }]) {
    await writeFile(path, JSON.stringify({ hosts: { opencode, codex } }));
    assert.throws(() => readRoutingConfig('opencode', env), /Invalid routing candidate settings/);
  }
  await writeFile(path, '{broken');
  assert.throws(() => readRoutingConfig('codex', env), /invalid JSON/);
  await rm(path);
  await symlink(join(root, 'other-settings.json'), path);
  assert.throws(() => readRoutingConfig('codex', env), /Could not open/);
});
