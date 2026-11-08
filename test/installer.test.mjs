import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const uninstaller = fileURLToPath(new URL('../uninstall.sh', import.meta.url));
const launcher = fileURLToPath(new URL('../bin/fm-pcc-router', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fm pcc router's setup "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source checkout');
  const command = join(source, 'install.sh');
  const remove = join(source, 'uninstall.sh');
  const log = join(root, 'installed-targets');
  const bin = join(root, 'bin');
  const shellFile = join(root, '.zshrc');
  for (const directory of ['bin', 'integrations/opencode', 'integrations/codex']) {
    await mkdir(join(source, directory), { recursive: true });
  }
  await copyFile(installer, command);
  await copyFile(uninstaller, remove);
  await cp(new URL('../installer/', import.meta.url), join(source, 'installer'), { recursive: true });
  await copyFile(launcher, join(source, 'bin/fm-pcc-router'));
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
    run: (args, env = {}) => spawnSync(args[0] === '--uninstall' ? remove : command, args[0] === '--uninstall' ? args.slice(1) : args, {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', XDG_BIN_HOME: bin,
        XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), FM_SETUP_TEST_LOG: log, ...env },
    }),
    targets: async () => (await readFile(log, 'utf8')).trim().split('\n'),
    bin, shellFile, root,
  };
}

async function seedCodexHost(root) {
  const installed = join(root, 'data/fm-pcc-router/codex');
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, '.fm-pcc-router-owned.json'), '{"owner":"fm-pcc-router"}');
  await writeFile(join(installed, 'uninstall.mjs'), [
    "import { rmSync } from 'node:fs';",
    "rmSync(new URL('.', import.meta.url), { recursive: true });",
  ].join('\n'));
  return installed;
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

test('setup preserves a conflicting user command and stops before installing hosts', async t => {
  const f = await fixture(t);
  await mkdir(f.bin);
  const command = join(f.bin, 'fm-pcc-router');
  await writeFile(command, 'Unrelated user command.');
  const result = f.run(['--target', 'both']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /existing unowned command/);
  assert.equal(await readFile(command, 'utf8'), 'Unrelated user command.');
  await assert.rejects(f.targets(), { code: 'ENOENT' });
});

test('concurrent setup cannot change hosts while the shared command is locked', async t => {
  const f = await fixture(t);
  await mkdir(f.bin);
  const lock = join(f.bin, '.fm-pcc-router-setup.lock');
  assert.equal(spawnSync('/usr/bin/shlock', ['-p', String(process.pid), '-f', lock]).status, 0);
  const result = f.run(['--target', 'both']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not lock FM PCC Router setup/);
  await assert.rejects(f.targets(), { code: 'ENOENT' });
  await rm(lock);
  assert.equal(f.run(['--target', 'both']).status, 0);
});

test('setup appends the command directory once and a new zsh finds it', async t => {
  const f = await fixture(t);
  const original = '# Existing shell settings';
  await writeFile(f.shellFile, original);
  for (let i = 0; i < 2; i++) assert.equal(f.run(['--target', 'opencode']).status, 0);
  const contents = await readFile(f.shellFile, 'utf8');
  assert.ok(contents.startsWith(original + '\n'));
  assert.equal(contents.match(/>>> FM PCC Router PATH >>>/g).length, 1);
  const shell = spawnSync('/bin/zsh', ['-ic', '. "$ZDOTDIR/.zshrc"; command -v fm-pcc-router; printf "%s" "$PATH"'], {
    encoding: 'utf8', env: { ...process.env, HOME: f.root, ZDOTDIR: f.root, PATH: '/usr/bin:/bin' },
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, `${join(f.bin, 'fm-pcc-router')}\n/usr/bin:/bin:${f.bin}`);
});

test('setup leaves shell settings alone when the directory is already on PATH', async t => {
  const f = await fixture(t);
  const result = f.run(['--target', 'opencode'], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:${f.bin}` });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(f.shellFile), { code: 'ENOENT' });
});

test('Bash setup appends to the first existing login file', async t => {
  const f = await fixture(t);
  const profile = join(f.root, '.profile');
  await writeFile(profile, '# Existing Bash profile\n');
  const result = f.run(['--target', 'opencode'], { SHELL: '/bin/bash' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(profile, 'utf8'), /^# Existing Bash profile\n\n# >>> FM PCC Router PATH >>>/);
  await assert.rejects(readFile(f.shellFile), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.root, '.bash_profile')), { code: 'ENOENT' });
});

test('setup reports the launcher path without modifying a symlinked startup file', async t => {
  const f = await fixture(t);
  const source = join(f.root, 'dotfiles.zsh');
  const original = '# User-managed settings\n';
  await writeFile(source, original);
  await symlink(source, f.shellFile);
  const result = f.run(['--target', 'opencode']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Refusing to edit unsafe file/);
  assert.ok(result.stderr.includes(join(f.bin, 'fm-pcc-router')));
  assert.equal(await readFile(source, 'utf8'), original);
});

test('uninstall exits cleanly before creating setup files when neither host is installed', async t => {
  const f = await fixture(t);
  for (const args of [['--uninstall'], ['--uninstall', '--target', 'both']]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'FM PCC Router is not installed.');
  }
  await assert.rejects(readFile(f.shellFile), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.bin, '.fm-pcc-router-setup.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(f.bin), { code: 'ENOENT' });
});

test('uninstall reports an unowned installation and preserves its contents', async t => {
  const f = await fixture(t);
  const unowned = join(f.root, 'config/opencode/plugins/fm-pcc-router');
  await mkdir(unowned, { recursive: true });
  const file = join(unowned, 'keep');
  await writeFile(file, 'User files.');
  const result = f.run(['--uninstall', '--target', 'both']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /for OpenCode: .*ownership could not be verified/);
  assert.equal(result.stdout, '');
  assert.equal(await readFile(file, 'utf8'), 'User files.');
  await assert.rejects(readFile(f.bin), { code: 'ENOENT' });
});

test('uninstall retries shared cleanup after the last host was removed', async t => {
  const f = await fixture(t);
  const original = '# Existing shell settings\n';
  await writeFile(f.shellFile, original);
  assert.equal(f.run(['--target', 'codex']).status, 0);
  const host = await seedCodexHost(f.root);
  const command = join(f.bin, 'fm-pcc-router');
  const record = join(f.bin, '.fm-pcc-router-shell-path');
  const configured = await readFile(f.shellFile, 'utf8');
  await writeFile(f.shellFile, configured.replace('export PATH=', 'export PATH=edited'));

  const first = f.run(['--uninstall', '--target', 'codex']);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /PATH block .* was edited/);
  await assert.rejects(readFile(join(host, 'uninstall.mjs')), { code: 'ENOENT' });
  await writeFile(f.shellFile, configured);

  const retry = f.run(['--uninstall']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Removed the shared command/);
  assert.equal(await readFile(f.shellFile, 'utf8'), original);
  await assert.rejects(readFile(command), { code: 'ENOENT' });
  await assert.rejects(readFile(record), { code: 'ENOENT' });
});

test('uninstall recovers a PATH record on its own only after all hosts are gone', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['--target', 'codex']).status, 0);
  const host = await seedCodexHost(f.root);
  const command = join(f.bin, 'fm-pcc-router');
  const record = join(f.bin, '.fm-pcc-router-shell-path');
  await rm(command);
  const configured = await readFile(f.shellFile, 'utf8');

  const otherHost = f.run(['--uninstall', '--target', 'opencode']);
  assert.equal(otherHost.status, 0, otherHost.stderr);
  assert.equal(await readFile(f.shellFile, 'utf8'), configured);
  assert.equal(await readFile(record, 'utf8'), f.shellFile);
  await rm(host, { recursive: true });

  const retry = f.run(['--uninstall', '--target', 'codex']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await readFile(f.shellFile, 'utf8'), '');
  await assert.rejects(readFile(record), { code: 'ENOENT' });
});

test('uninstall recovers an orphaned launcher only with verified ownership', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['--target', 'codex'], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:${f.bin}` }).status, 0);
  const command = join(f.bin, 'fm-pcc-router');
  const unowned = join(f.root, 'config/opencode/plugins/fm-pcc-router');
  await mkdir(unowned, { recursive: true });

  const uncertain = f.run(['--uninstall', '--target', 'codex']);
  assert.equal(uncertain.status, 1, uncertain.stderr);
  assert.match(uncertain.stderr, /ownership could not be verified/);
  assert.deepEqual(await readFile(command), await readFile(launcher));
  await rm(unowned, { recursive: true });

  const retry = f.run(['--uninstall', '--target', 'codex']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Removed the shared command/);
  await assert.rejects(readFile(command), { code: 'ENOENT' });
  await assert.rejects(readFile(f.shellFile), { code: 'ENOENT' });
});
