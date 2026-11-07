import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, cp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pcc-router installer '));
  const source = path.join(temp, 'download [with spaces]');
  const xdg = path.join(temp, 'config [preserve me]');
  await mkdir(source, { recursive: true });
  for (const rel of ['LICENSE', 'package.json', 'src', 'integrations']) {
    await cp(path.join(project, rel), path.join(source, rel), { recursive: true });
  }
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, source, xdg, config: path.join(xdg, 'opencode'), plugins: path.join(xdg, 'opencode', 'plugins'), installed: path.join(xdg, 'opencode', 'plugins', 'fm-pcc-router') };
}

function run(bundle, action, xdg, extraEnv = {}) {
  return spawnSync('/bin/zsh', ['-f', path.join(bundle, 'integrations/opencode/manage.zsh'), action], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg, ...extraEnv },
    timeout: 10_000,
  });
}

async function seedExistingConfig(config) {
  await mkdir(path.join(config, 'plugins', 'another-plugin'), { recursive: true });
  const jsonc = '{\n  // user provider settings stay intact\n  "provider": { "anthropic": { "options": { "apiKey": "kept" } } },\n}\n';
  await writeFile(path.join(config, 'opencode.jsonc'), jsonc);
  await writeFile(path.join(config, 'plugins', 'another-plugin', 'index.js'), 'export default {};\n');
  return jsonc;
}

test('installs only the runtime into global plugins and safely repeats without changing user config', async (t) => {
  const f = await fixture(t);
  const originalJsonc = await seedExistingConfig(path.join(f.xdg, 'opencode'));

  const installed = run(f.source, 'install', f.xdg);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed FM PCC Router for OpenCode/);
  assert.equal(await readFile(path.join(f.config, 'opencode.jsonc'), 'utf8'), originalJsonc);
  assert.equal(await readFile(path.join(f.plugins, 'another-plugin', 'index.js'), 'utf8'), 'export default {};\n');
  assert.deepEqual((await readdir(f.installed)).sort(), ['.fm-pcc-router-owned', 'LICENSE', 'integrations', 'package.json', 'src']);
  assert.equal(await readFile(path.join(f.installed, 'LICENSE'), 'utf8'), await readFile(path.join(f.source, 'LICENSE'), 'utf8'));
  assert.deepEqual(await readdir(path.join(f.installed, 'integrations')), ['opencode']);
  assert.deepEqual((await readdir(path.join(f.installed, 'src'))).sort(), [
    'bridge.mjs', 'http.mjs', 'routing.mjs', 'terminal.mjs',
  ]);
  assert.equal((await stat(path.join(f.installed, 'integrations/opencode/manage.zsh'))).mode & 0o111, 0o111);

  const repeated = run(f.source, 'install', f.xdg);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already installed/);
  assert.deepEqual((await readdir(f.config)).sort(), ['opencode.jsonc', 'plugins'].sort());

  await rm(f.source, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(f.installed, 'package.json'), 'utf8'));
  const { default: plugin } = await import(pathToFileURL(path.join(f.installed, manifest.exports['.'])).href);
  assert.equal(plugin.id, 'foundation-pcc-probe');
  const uninstalled = run(f.installed, 'uninstall', f.xdg);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(await readFile(path.join(f.config, 'opencode.jsonc'), 'utf8'), originalJsonc);
  assert.equal(await readFile(path.join(f.plugins, 'another-plugin', 'index.js'), 'utf8'), 'export default {};\n');
});

test('refuses an existing unowned destination without changing it', async (t) => {
  const f = await fixture(t);
  await mkdir(f.installed, { recursive: true });
  await writeFile(path.join(f.installed, 'user-file'), 'keep');
  const result = run(f.source, 'install', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unowned path/);
  assert.equal(await readFile(path.join(f.installed, 'user-file'), 'utf8'), 'keep');
});

test('refuses a symlinked destination and never follows it', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.temp, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'keep');
  await mkdir(f.plugins, { recursive: true });
  await symlink(outside, f.installed);
  const result = run(f.source, 'install', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
});

test('refuses to uninstall if an owned directory contains unexpected files', async (t) => {
  const f = await fixture(t);
  const install = run(f.source, 'install', f.xdg);
  assert.equal(install.status, 0, install.stderr);
  await writeFile(path.join(f.installed, 'user-file'), 'keep');
  const result = run(f.source, 'uninstall', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected files/);
  assert.equal(await readFile(path.join(f.installed, 'user-file'), 'utf8'), 'keep');
});

test('the installed uninstaller does not delegate to an unexpected installer beside it', async (t) => {
  const f = await fixture(t);
  const install = run(f.source, 'install', f.xdg);
  assert.equal(install.status, 0, install.stderr);
  await writeFile(path.join(f.installed, 'install.sh'), 'print "unexpected installer ran"\n');
  const result = run(f.installed, 'uninstall', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected files/);
  assert.doesNotMatch(result.stdout, /unexpected installer ran/);
});

test('rejects incomplete source and cleans any staging directory', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'src', 'bridge.mjs'));
  const result = run(f.source, 'install', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete/);
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  await assert.rejects(readdir(f.config));
});

test('uninstall succeeds when the plugin is already absent', async (t) => {
  const f = await fixture(t);
  const result = run(f.source, 'uninstall', f.xdg);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not installed/);
});


test('failed staging copy leaves no partial plugin and preserves existing settings', async (t) => {
  const f = await fixture(t);
  const original = await seedExistingConfig(f.config);
  const tools = path.join(f.temp, 'failing-tools');
  await mkdir(tools);
  await writeFile(path.join(tools, 'cp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = run(f.source, 'install', f.xdg, { PATH: `${tools}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not copy/);
  await assert.rejects(stat(f.installed), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.config)).sort(), ['opencode.jsonc', 'plugins']);
  assert.equal(await readFile(path.join(f.config, 'opencode.jsonc'), 'utf8'), original);
});

test('changed source requires explicit removal and leaves the installed copy intact', async (t) => {
  const f = await fixture(t);
  const first = run(f.source, 'install', f.xdg);
  assert.equal(first.status, 0, first.stderr);
  const entry = 'integrations/opencode/index.js';
  const original = await readFile(path.join(f.installed, entry), 'utf8');
  await writeFile(path.join(f.source, entry), '// changed source\n');
  const result = run(f.source, 'install', f.xdg);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different files/);
  assert.equal(await readFile(path.join(f.installed, entry), 'utf8'), original);
  assert.deepEqual(await readdir(f.config), ['plugins']);
});
