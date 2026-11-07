import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { manageCodex } from '../integrations/codex/manage.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const setup = join(project, 'install.mjs');
const bundledSkill = 'integrations/codex/skills/fm-pcc-router';
const unrelatedHook = { hooks: [{ type: 'command', command: 'existing-user-hook' }] };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm pcc router's install ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataHome = join(root, 'data');
  const configHome = join(root, 'config');
  const codexHome = join(root, 'codex-user-config');
  const hooksPath = join(codexHome, 'hooks.json');
  const installed = join(dataHome, 'fm-pcc-router/codex');
  return {
    root, installed, hooksPath, configHome, dataHome, skill: join(codexHome, 'skills/fm-pcc-router'),
    openCode: join(configHome, 'opencode/plugins/fm-pcc-router'),
    writeHooks: async data => {
      await mkdir(codexHome, { recursive: true });
      await writeFile(hooksPath, JSON.stringify(data));
    },
    hooks: async () => JSON.parse(await readFile(hooksPath, 'utf8')),
    manage: action => manageCodex(action, { dataHome, codexHome }),
    run: (...args) => spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CODEX_HOME: codexHome, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome },
      encoding: 'utf8', timeout: 10_000,
    }),
  };
}

test('Codex installs its skill and user hooks alongside existing hooks and runs from the staged files', async t => {
  const f = await fixture(t);
  const original = { description: 'User hooks', hooks: { UserPromptSubmit: [unrelatedHook] } };
  await f.writeHooks(original);
  f.manage('install');
  f.manage('install');
  assert.deepEqual(await readdir(f.dataHome), ['fm-pcc-router']);
  assert.deepEqual((await readdir(f.installed)).sort(), ['.fm-pcc-router-owned.json', 'LICENSE', 'integrations', 'src', 'uninstall.mjs']);
  assert.equal(await readlink(f.skill), join(f.installed, bundledSkill));
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), await readFile(join(project, bundledSkill, 'SKILL.md'), 'utf8'));
  assert.equal(await readFile(join(f.installed, 'LICENSE'), 'utf8'), await readFile(join(project, 'LICENSE'), 'utf8'));
  await assert.rejects(stat(f.configHome), { code: 'ENOENT' });
  const { description, hooks } = await f.hooks();
  assert.equal(description, original.description);
  assert.equal(hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(hooks.UserPromptSubmit[0], unrelatedHook);
  assert.equal(hooks.PostModelRequest.length, 1);

  const prompt = 'Private prompt fixture 71'.repeat(4000);
  const result = spawnSync('/bin/zsh', ['-f', '-c', hooks.UserPromptSubmit[1].hooks[0].command], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { hookSpecificOutput } = JSON.parse(result.stdout);
  assert.equal(hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const workflow = join(f.installed, 'integrations/codex/routing.md');
  assert.ok(hookSpecificOutput.additionalContext.includes(workflow));
  assert.doesNotMatch(result.stdout, /Private prompt fixture 71/);
  await stat(workflow);
  const audit = spawnSync('/bin/zsh', ['-f', '-c', hooks.PostModelRequest[0].hooks[0].command], {
    input: '{}', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(audit.status, 0, audit.stderr);

  const removed = f.run(join(f.installed, 'uninstall.mjs'));
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  await assert.rejects(lstat(f.skill), { code: 'ENOENT' });
  assert.deepEqual(await f.hooks(), original);
});

test('removal preserves indexes and entries added by the user after installation', async t => {
  const f = await fixture(t);
  f.manage('install');
  const config = await f.hooks();
  config.hooks.UserPromptSubmit.push(unrelatedHook);
  await f.writeHooks(config);
  f.manage('uninstall');
  assert.deepEqual(await f.hooks(), { hooks: { UserPromptSubmit: [{ hooks: [] }, unrelatedHook] } });
});

test('install refuses invalid or symlinked hook configuration without installing the router', async t => {
  const f = await fixture(t);
  await f.writeHooks({ hooks: { UserPromptSubmit: 'invalid' } });
  assert.throws(() => f.manage('install'), /Invalid Codex hook groups/);
  assert.deepEqual(await f.hooks(), { hooks: { UserPromptSubmit: 'invalid' } });
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  await assert.rejects(lstat(f.skill), { code: 'ENOENT' });

  await rm(f.hooksPath);
  const other = join(f.root, 'other-hooks.json');
  await writeFile(other, '{}');
  await symlink(other, f.hooksPath);
  assert.throws(() => f.manage('install'), /regular file/);
  assert.equal(await readFile(other, 'utf8'), '{}');
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
});

test('uninstall refuses an edited owned hook without deleting the runtime', async t => {
  const f = await fixture(t);
  f.manage('install');
  const config = await f.hooks();
  config.hooks.UserPromptSubmit[0].hooks[0].timeout = 7;
  await f.writeHooks(config);
  assert.throws(() => f.manage('uninstall'), /hook was edited/);
  assert.deepEqual(await f.hooks(), config);
  await stat(f.installed);
});

test('install and uninstall preserve an independently managed Codex skill', async t => {
  const f = await fixture(t);
  const addUnrelatedSkill = async () => {
    await mkdir(f.skill, { recursive: true });
    await writeFile(join(f.skill, 'SKILL.md'), 'Independent skill');
  };
  await addUnrelatedSkill();
  assert.throws(() => f.manage('install'), /A Codex skill already exists/);
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  await assert.rejects(stat(f.hooksPath), { code: 'ENOENT' });
  await rm(f.skill, { recursive: true });
  f.manage('install');
  await rm(f.skill);
  await addUnrelatedSkill();
  f.manage('uninstall');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'Independent skill');
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  await assert.rejects(stat(f.hooksPath), { code: 'ENOENT' });
});

test('the checkout installer removes both integrations and their owned registrations', async t => {
  const f = await fixture(t);
  const installed = f.run(setup, '--target', 'both');
  assert.equal(installed.status, 0, installed.stderr);
  await stat(f.openCode);
  await stat(f.installed);
  await stat(join(f.skill, 'SKILL.md'));
  const removed = f.run(setup, '--uninstall', '--target', 'both');
  assert.equal(removed.status, 0, removed.stderr);
  for (const path of [f.openCode, f.installed, f.hooksPath]) {
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  await assert.rejects(lstat(f.skill), { code: 'ENOENT' });
  assert.equal(f.run(setup, '--uninstall', '--target', 'both').status, 0);
});
