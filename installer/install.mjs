import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chooseTargets } from './menu.mjs';
import { hasShellPathRecord, updateShellPath } from './shell-path.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const hosts = { opencode: 'OpenCode', codex: 'Codex' };
const usage = 'Usage: ./install.sh [--target <opencode|codex|both>]\n       ./uninstall.sh [--target <opencode|codex|both>]';
// Recognize the exact launcher shipped in v0.5.0 during upgrades and removal.
const legacyLauncherHash = '06b796f70bd6f5967000b77b8409e653c46905a24a2b1cba1b403d1d783d531e';

function targetDirectory(target) {
  const opencode = target === 'opencode';
  const base = opencode ? process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  if (!isAbsolute(base)) throw new Error('The installation base path must be absolute.');
  return join(base, opencode ? 'opencode/plugins/fm-pcc-router' : 'fm-pcc-router/codex');
}

function installedDirectory(target) {
  const opencode = target === 'opencode';
  const directory = targetDirectory(target);
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

function inspectTargets(targets) {
  return targets.map(id => {
    const label = hosts[id];
    try {
      const installed = Boolean(installedDirectory(id));
      return { id, label, installed, status: installed ? 'Installed' : '' };
    } catch (error) {
      console.error(`FM PCC Router for ${label}: ${error.message}`);
      return { id, label, disabled: true, status: 'Unavailable' };
    }
  });
}

function launcherPath() {
  const base = process.env.XDG_BIN_HOME || join(homedir(), '.local/bin');
  if (!isAbsolute(base)) throw new Error('The command directory must be absolute.');
  return join(base, 'fm-pcc-router');
}

function launcherState(path, template, failOnConflict = true) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isFile() && info.uid === process.getuid() && !(info.mode & 0o022) && info.size <= template.length) {
    const contents = readFileSync(path);
    if (contents.equals(template)) return 'current';
    if (createHash('sha256').update(contents).digest('hex') === legacyLauncherHash) return 'legacy';
  }
  if (failOnConflict) {
    throw new Error(`Refusing to change an existing unowned command at '${path}'.`);
  }
}

function installLauncher(path, template) {
  if (launcherState(path, template) === 'current') return;
  const directory = dirname(path);
  const stage = mkdtempSync(join(directory, '.fm-pcc-router-'));
  try {
    const temporary = join(stage, 'command');
    writeFileSync(temporary, template, { mode: 0o755 });
    if (launcherState(path, template) === 'legacy') {
      renameSync(temporary, path);
    } else {
      try { linkSync(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST' || launcherState(path, template) !== 'current') throw error;
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`Installed the shared command at '${path}'.`);
}

function configureShellPath(path) {
  try {
    const rc = updateShellPath(dirname(path));
    if (rc) console.log(`Configured PATH in '${rc}'. Open a new terminal tab to use fm-pcc-router.`);
  } catch (error) {
    console.error(`FM PCC Router: ${error.message} Run the command at '${path}'.`);
  }
}

function withSetupLock(path, uninstall, action) {
  const directory = dirname(path);
  const created = mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.fm-pcc-router-setup.lock');
  const result = spawnSync('/usr/bin/shlock', ['-p', String(process.pid), '-f', lock], { timeout: 2500 });
  if (result.status !== 0) throw new Error('Could not lock FM PCC Router setup. Retry after the other setup finishes.');
  try {
    action();
  } finally {
    unlinkSync(lock);
    if (created && uninstall) {
      try { rmdirSync(directory); }
      catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
  }
}

function hasInstalledHost() {
  return Object.keys(hosts).some(target => installedDirectory(target));
}

function removeLauncher(path, template) {
  if (hasInstalledHost()) return;
  updateShellPath(dirname(path), true);
  if (!launcherState(path, template, false)) return;
  unlinkSync(path);
  console.log(`Removed the shared command at '${path}'.`);
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

function runTargets(targets, action) {
  let succeeded = false;
  for (const selected of targets) {
    try {
      runTarget(selected, action);
      succeeded = true;
    } catch (error) {
      console.error(`FM PCC Router ${action} failed for ${selected}. ${error.message}`);
      process.exitCode = 1;
    }
  }
  return succeeded;
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
  const { target, uninstall } = values;
  if (target !== undefined && target !== 'both' && !Object.hasOwn(hosts, target)) {
    throw new Error('Supported targets are opencode, codex, and both.');
  }
  let targets = !target || target === 'both' ? Object.keys(hosts) : [target];
  if (uninstall || !target) {
    const inspected = inspectTargets(targets);
    const blocked = inspected.some(row => row.disabled);
    const rows = uninstall ? inspected.filter(row => row.installed) : inspected;
    if (target && blocked) process.exitCode = 1;
    if (rows.every(row => row.disabled)) {
      if (blocked) {
        process.exitCode = 1;
        return;
      }
      targets = [];
    } else {
      targets = target ? rows.map(row => row.id) : await chooseTargets(rows, uninstall ? 'Uninstall' : 'Install');
      if (!targets.length) {
        console.log('Cancelled.');
        return;
      }
    }
  }
  const path = launcherPath();
  const template = readFileSync(join(source, 'bin/fm-pcc-router'));
  if (uninstall && !targets.length
      && ((!launcherState(path, template, false) && !hasShellPathRecord(dirname(path))) || hasInstalledHost())) {
    console.log(target && target !== 'both'
      ? `FM PCC Router for ${hosts[target]} is not installed.` : 'FM PCC Router is not installed.');
    return;
  }
  withSetupLock(path, values.uninstall, () => {
    if (values.uninstall) {
      runTargets(targets, 'uninstall');
      removeLauncher(path, template);
    } else {
      launcherState(path, template);
      if (runTargets(targets, 'install')) {
        installLauncher(path, template);
        configureShellPath(path);
      }
    }
  });
}

try {
  await main();
} catch (error) {
  console.error('FM PCC Router setup: ' + error.message);
  process.exitCode = 1;
}
