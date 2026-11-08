import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const entry = fileURLToPath(import.meta.url);
const source = fileURLToPath(new URL('../../', import.meta.url));
const integration = 'integrations/codex';
const registration = '.fm-pcc-router-owned.json';
const skill = 'skills/fm-pcc-router';
const bundledSkill = join(integration, skill);
const files = [
  'LICENSE',
  ...['codex-route.mjs', 'codex-audit.mjs', 'routing.md'].map(file => join(integration, file)),
  ...['bridge.mjs', 'cli.mjs', 'doctor.mjs', 'routing-config.mjs', 'routing.mjs', 'session.mjs', 'strategies.mjs', 'terminal.mjs'].map(file => join('src', file)),
  join(bundledSkill, 'SKILL.md'),
  join(bundledSkill, 'LICENSE'),
];
const expected = [
  ...files, registration, 'uninstall.mjs', 'src', 'integrations', integration, dirname(bundledSkill), bundledSkill,
].sort();

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function hooksFor(directory, node) {
  const command = (file, flag) => [
    quote(node), quote(join(directory, integration, file)), flag,
  ].join(' ');
  return {
    UserPromptSubmit: { hooks: [{
      type: 'command', command: command('codex-route.mjs', '--user-prompt-submit'),
      timeout: 5, statusMessage: 'FM PCC Router',
    }] },
    PostModelRequest: { hooks: [{
      type: 'command', command: command('codex-audit.mjs', 'observe'),
      timeout: 5, statusMessage: 'Checking the FM PCC Router model',
    }] },
  };
}

function readHooks(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { config: { hooks: {} }, text: undefined, mode: 0o600 };
  if (!info.isFile()) throw new Error('Codex hooks.json must be a regular file.');
  const text = readFileSync(path, 'utf8');
  const config = JSON.parse(text);
  if (!isObject(config) || ('hooks' in config && !isObject(config.hooks))) {
    throw new Error('Codex hooks.json has an invalid structure.');
  }
  return { config, text, mode: info.mode & 0o777 };
}

function writeHooks(path, before, config) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, '.fm-pcc-hooks-'));
  try {
    const temporary = join(stage, 'hooks.json');
    if (config) {
      writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: before.mode });
      chmodSync(temporary, before.mode);
    }
    if (readHooks(path).text !== before.text) throw new Error('Codex hooks.json changed. Retry the operation.');
    if (config) renameSync(temporary, path);
    else rmSync(path);
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } catch { /* The hook update may already be committed. */ }
  }
}

function listEntries(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return [name, ...listEntries(directory, name)];
    if (!entry.isFile()) throw new Error('The installed Codex router contains a symlink or special file.');
    return [name];
  });
}

function inspect(directory) {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory() || !isDeepStrictEqual(listEntries(directory).sort(), expected)) {
    throw new Error('Refusing to modify an unowned Codex router directory or unexpected files.');
  }
  const record = JSON.parse(readFileSync(join(directory, registration), 'utf8'));
  if (!isObject(record) || record.owner !== 'fm-pcc-router'
      || typeof record.hooksPath !== 'string' || !isAbsolute(record.hooksPath)
      || basename(record.hooksPath) !== 'hooks.json'
      || typeof record.node !== 'string' || !isAbsolute(record.node)
      || typeof record.createdHooks !== 'boolean'
      || !isDeepStrictEqual(record.groups, hooksFor(directory, record.node))) {
    throw new Error('The Codex router ownership record is invalid.');
  }
  return record;
}

function updateHooks(record, action) {
  const before = readHooks(record.hooksPath);
  const config = before.config;
  if (action === 'uninstall' && before.text === undefined) return;
  const hooks = config.hooks ??= {};
  let changed = false;
  for (const [event, owned] of Object.entries(record.groups)) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Invalid Codex hook groups for ${event}.`);
    const matches = groups.map((group, index) => isDeepStrictEqual(group, owned) ? index : -1).filter(index => index >= 0);
    const command = owned.hooks[0].command;
    if (groups.some((group, index) => !matches.includes(index) && Array.isArray(group?.hooks)
        && group.hooks.some(handler => handler?.command === command))) {
      throw new Error(`The FM PCC Router ${event} hook was edited. Review it before continuing.`);
    }
    if (action === 'install' && matches.length === 0) {
      hooks[event] = [...groups, owned];
      changed = true;
    }
    if (action === 'uninstall' && matches.length > 0) {
      // Leave empty slots ahead of unrelated hooks so their trust keys keep their indexes.
      hooks[event] = groups.map((group, index) => matches.includes(index) ? { hooks: [] } : group);
      while (matches.includes(hooks[event].length - 1)) hooks[event].pop();
      if (hooks[event].length === 0) delete hooks[event];
      changed = true;
    }
  }
  if (!changed) return;
  const empty = Object.keys(config).length === 1 && Object.keys(hooks).length === 0;
  writeHooks(record.hooksPath, before, record.createdHooks && empty ? undefined : config);
}

function updateRegistration(directory, record, action) {
  const link = join(dirname(record.hooksPath), skill);
  const target = join(directory, bundledSkill);
  const info = lstatSync(link, { throwIfNoEntry: false });
  const owned = info?.isSymbolicLink() && readlinkSync(link) === target;
  if (action === 'uninstall') {
    updateHooks(record, action);
    if (owned) unlinkSync(link);
    return;
  }
  if (info && !owned) throw new Error(`A Codex skill already exists at '${link}'. Move it before installing FM PCC Router.`);
  if (!owned) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
  try {
    updateHooks(record, action);
  } catch (error) {
    if (!owned) unlinkSync(link);
    throw error;
  }
}

export function manageCodex(action, {
  dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  if (!['install', 'uninstall'].includes(action)) throw new Error('Specify install or uninstall.');
  if (!isAbsolute(dataHome) || !isAbsolute(codexHome)) throw new Error('Codex base paths must be absolute.');
  const parent = join(dataHome, 'fm-pcc-router');
  if (action === 'uninstall' && !lstatSync(join(parent, 'codex'), { throwIfNoEntry: false })) {
    console.log('FM PCC Router for Codex is not installed.');
    return;
  }
  mkdirSync(parent, { recursive: true });
  const directory = join(realpathSync(parent), 'codex');
  const lock = directory + '.lock';
  mkdirSync(lock);
  try {
    const present = inspect(directory);
    if (action === 'uninstall') {
      if (!present) return;
      updateRegistration(directory, present, action);
      rmSync(directory, { recursive: true });
      console.log('Removed FM PCC Router for Codex.');
      return;
    }

    const hooksPath = join(codexHome, 'hooks.json');
    if (present) {
      if (present.hooksPath !== hooksPath || files.some(file =>
        !readFileSync(join(directory, file)).equals(readFileSync(join(source, file))))
        || !readFileSync(join(directory, 'uninstall.mjs')).equals(readFileSync(entry))) {
        throw new Error('The existing Codex router differs. Remove it before reinstalling.');
      }
      updateRegistration(directory, present, action);
    } else {
      const node = process.execPath;
      const record = { owner: 'fm-pcc-router', hooksPath, node, groups: hooksFor(directory, node),
        createdHooks: readHooks(hooksPath).text === undefined };
      const stage = mkdtempSync(join(dirname(directory), '.fm-pcc-stage-'));
      try {
        for (const file of files) {
          mkdirSync(dirname(join(stage, file)), { recursive: true });
          copyFileSync(join(source, file), join(stage, file));
        }
        copyFileSync(entry, join(stage, 'uninstall.mjs'));
        writeFileSync(join(stage, registration), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
        renameSync(stage, directory);
        try { updateRegistration(directory, record, action); }
        catch (error) { rmSync(directory, { recursive: true }); throw error; }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    console.log('Installed FM PCC Router for Codex.');
    console.log('Quit and reopen the Codex app to load the new hooks. Then review and trust UserPromptSubmit in Settings > Hooks.');
  } finally {
    rmdirSync(lock);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === entry) {
  try {
    if (basename(entry) === 'uninstall.mjs') {
      const directory = dirname(entry);
      if (basename(directory) !== 'codex' || basename(dirname(directory)) !== 'fm-pcc-router') {
        throw new Error('Run the Codex uninstaller from its installed directory.');
      }
      manageCodex('uninstall', { dataHome: dirname(dirname(directory)) });
    } else {
      manageCodex(process.argv[2]);
    }
  } catch (error) {
    console.error('FM PCC Router (Codex): ' + error.message);
    process.exitCode = 1;
  }
}
