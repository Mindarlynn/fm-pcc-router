import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fm pcc setup test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source checkout');
  const command = join(source, 'install.mjs');
  const log = join(root, 'installed-targets');
  for (const directory of ['integrations/opencode', 'integrations/codex']) {
    await mkdir(join(source, directory), { recursive: true });
  }
  await copyFile(installer, command);
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
    run: (args, env = {}) => spawnSync(process.execPath, [command, ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, FM_SETUP_TEST_LOG: log, ...env },
    }),
    targets: async () => (await readFile(log, 'utf8')).trim().split('\n'),
  };
}

for (const [target, expected] of [
  ['opencode', ['opencode']],
  ['codex', ['codex']],
  ['both', ['opencode', 'codex']],
]) {
  test(`the checkout installer runs only the selected install targets for ${target}`, async t => {
    const f = await fixture(t);
    const result = f.run(['--target', target]);
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
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  await assert.rejects(f.targets(), { code: 'ENOENT' });
});

test('setup reports a partial failure and still attempts the other selected host', async t => {
  const f = await fixture(t);
  const result = f.run(['--target', 'both'], { FM_SETUP_TEST_FAIL: 'opencode' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install failed for opencode/);
  assert.match(result.stdout, /Installed Codex fixture/);
  assert.deepEqual(await f.targets(), ['opencode', 'codex']);
});
