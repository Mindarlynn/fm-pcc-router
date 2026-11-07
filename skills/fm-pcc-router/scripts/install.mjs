import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const targetOptions = ['opencode', 'codex', 'both'];
const usage = [
  'Usage: node install.mjs --source <local-checkout|https-repository> [--ref <tag|commit>] [--target <opencode|codex|both>]',
  '       node install.mjs --uninstall [--target <opencode|codex|both>]',
].join('\n');

async function chooseTarget() {
  if (!process.stdin.isTTY) throw new Error('Specify --target opencode, codex, or both.');
  console.log('1) OpenCode\n2) Codex\n3) Both');
  const menu = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return targetOptions[Number((await menu.question('Choose a target [1/2/3]: ')).trim()) - 1];
  } finally {
    menu.close();
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', timeout: 120_000 });
  if (result.error?.code === 'ENOENT') throw new Error('Git is required to install from a release.');
  if (result.status !== 0) throw new Error(`Could not prepare the selected release (git ${args[0]}).`);
}

function checkoutRelease(directory, source, ref) {
  const url = new URL(source);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS repository URL without credentials, a query, or a fragment.');
  }
  if (!ref) throw new Error('An HTTPS source requires --ref with a release tag or full commit SHA.');
  const commit = /^[0-9a-f]{40}$/i.test(ref);
  const gitRef = commit ? ref : 'refs/tags/' + ref;
  if (!commit) git(directory, ['check-ref-format', gitRef]);
  git(directory, ['init', '--quiet']);
  git(directory, ['fetch', '--quiet', '--depth=1', '--no-tags', '--', source, gitRef]);
  git(directory, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
}

function installedDirectory(target) {
  const opencode = target === 'opencode';
  const base = opencode ? process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  if (!isAbsolute(base)) throw new Error('The installation base path must be absolute.');
  const directory = join(base, opencode ? 'opencode/plugins/fm-pcc-router' : 'fm-pcc-router/codex');
  const location = lstatSync(directory, { throwIfNoEntry: false });
  if (!location) return;
  if (!location.isDirectory()) throw new Error('The installed router path is not a directory.');
  const marker = join(directory, opencode ? '.fm-pcc-router-owned' : '.fm-pcc-router-owned.json');
  if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('The installed router ownership could not be verified.');
  }
  const content = readFileSync(marker, 'utf8');
  const owned = opencode ? content === 'fm-pcc-router installer ownership marker v1\n'
    : JSON.parse(content)?.owner === 'fm-pcc-router';
  if (!owned) {
    throw new Error('The installed router ownership could not be verified.');
  }
  return realpathSync(directory);
}

function runTarget(target, action, source) {
  const opencode = target === 'opencode';
  const directory = source ?? installedDirectory(target);
  if (!directory) {
    console.log(`FM PCC Router for ${target} is not installed.`);
    return;
  }
  const manager = opencode ? 'integrations/opencode/manage.zsh'
    : action === 'install' ? 'integrations/codex/manage.mjs' : 'uninstall.mjs';
  const script = join(directory, manager);
  if (!lstatSync(script, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`The ${target} ${action} command is missing.`);
  }
  if (action === 'uninstall' && realpathSync(script) !== script) {
    throw new Error('The installed router command resolves through a symlink.');
  }
  const executable = opencode ? '/bin/zsh' : process.execPath;
  const args = opencode ? ['-f', script, action] : [script, action];
  const result = spawnSync(executable, args, { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The ${target} command failed.`);
}

function runTargets(target, action, source) {
  for (const selected of target === 'both' ? ['opencode', 'codex'] : [target]) {
    try {
      runTarget(selected, action, source);
    } catch (error) {
      console.error(`FM PCC Router ${action} failed for ${selected}. ${error.message}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' },
    ref: { type: 'string' },
    target: { type: 'string' },
    uninstall: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  const target = values.target ?? await chooseTarget();
  if (!targetOptions.includes(target)) {
    throw new Error('Supported targets are opencode, codex, and both.');
  }
  if (values.uninstall) {
    if (values.source !== undefined || values.ref !== undefined) {
      throw new Error('Uninstall uses the installed files. Omit --source and --ref.');
    }
    runTargets(target, 'uninstall');
    return;
  }
  if (!values.source) throw new Error(usage);
  if (values.source.startsWith('https://')) {
    const directory = mkdtempSync(join(tmpdir(), 'fm-pcc-setup-'));
    try {
      checkoutRelease(directory, values.source, values.ref);
      runTargets(target, 'install', directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else {
    if (values.ref !== undefined) throw new Error('--ref is only supported for HTTPS repositories.');
    runTargets(target, 'install', resolve(values.source));
  }
}

try {
  await main();
} catch (error) {
  console.error('FM PCC Router setup: ' + error.message);
  process.exitCode = 1;
}
