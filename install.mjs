import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const source = fileURLToPath(new URL('.', import.meta.url));
const targetOptions = ['opencode', 'codex', 'both'];
const usage = 'Usage: node install.mjs [--uninstall] [--target <opencode|codex|both>]';

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

function runTarget(target, action) {
  const opencode = target === 'opencode';
  const directory = action === 'install' ? source : installedDirectory(target);
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

function runTargets(target, action) {
  for (const selected of target === 'both' ? ['opencode', 'codex'] : [target]) {
    try {
      runTarget(selected, action);
    } catch (error) {
      console.error(`FM PCC Router ${action} failed for ${selected}. ${error.message}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
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
  runTargets(target, values.uninstall ? 'uninstall' : 'install');
}

try {
  await main();
} catch (error) {
  console.error('FM PCC Router setup: ' + error.message);
  process.exitCode = 1;
}
