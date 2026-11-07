import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../skills/fm-pcc-router/scripts/install.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fm pcc setup test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source checkout');
  const installedSkill = join(root, 'standalone install.mjs');
  const log = join(root, 'installed-targets');
  const temporary = join(root, 'downloads');
  for (const directory of ['integrations/opencode', 'integrations/codex']) {
    await mkdir(join(source, directory), { recursive: true });
  }
  await mkdir(temporary);
  await copyFile(installer, installedSkill);
  await writeFile(join(source, 'integrations/opencode/manage.zsh'), [
    '#!/bin/zsh -f',
    '[[ "$1" == install ]] || exit 1',
    'print -r -- opencode >> "$FM_SETUP_TEST_LOG"',
    '[[ "$FM_SETUP_TEST_FAIL" != opencode ]]',
    '',
  ].join('\n'));
  await writeFile(join(source, 'integrations/codex/manage.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "if (process.argv[2] !== 'install') process.exit(1);",
    "appendFileSync(process.env.FM_SETUP_TEST_LOG, 'codex\\n');",
    "console.log('Installed Codex fixture.');",
    '',
  ].join('\n'));
  return {
    source,
    temporary,
    run: (args, env = {}) => spawnSync(process.execPath, [installedSkill, ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, TMPDIR: temporary, FM_SETUP_TEST_LOG: log, ...env },
    }),
    targets: async () => (await readFile(log, 'utf8')).trim().split('\n'),
  };
}

for (const [target, expected] of [
  ['opencode', ['opencode']],
  ['codex', ['codex']],
  ['both', ['opencode', 'codex']],
]) {
  test(`setup runs only the selected install targets for ${target}`, async t => {
    const f = await fixture(t);
    const result = f.run(['--source', f.source, '--target', target]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await f.targets(), expected);
  });
}

test('setup rejects unsupported or unspecified non-interactive targets before installation', async t => {
  const f = await fixture(t);
  for (const [args, error] of [
    [['--target', 'claude-code'], /Supported targets/],
    [[], /Specify --target/],
  ]) {
    const result = f.run(['--source', f.source, ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  await assert.rejects(f.targets(), { code: 'ENOENT' });
});

test('setup reports a partial failure and still attempts the other selected host', async t => {
  const f = await fixture(t);
  const result = f.run(['--source', f.source, '--target', 'both'], { FM_SETUP_TEST_FAIL: 'opencode' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install failed for opencode/);
  assert.match(result.stdout, /Installed Codex fixture/);
  assert.deepEqual(await f.targets(), ['opencode', 'codex']);
});

test('setup fetches the exact release tag and cleans the checkout', async t => {
  const f = await fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=FM PCC Router Test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Release fixture');
  git('tag', 'v1.2.3');
  await writeFile(join(f.source, 'integrations/codex/manage.mjs'), 'process.exit(1);\n');
  git('-c', 'user.name=FM PCC Router Test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-am', 'Newer unreleased fixture');
  const url = 'https://example.invalid/fm-pcc-router';
  const missing = f.run(['--source', url, '--target', 'codex']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --ref/);
  const result = f.run(['--source', url, '--ref', 'v1.2.3', '--target', 'codex'], {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${f.source}.insteadOf`,
    GIT_CONFIG_VALUE_0: url,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.targets(), ['codex']);
  assert.ok((await readdir(f.temporary)).every(name => !name.startsWith('fm-pcc-setup-')));
});
