import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readRoutingConfig } from './routing-config.mjs';
import { defaultSessionRoot } from './session.mjs';
import { RoutingStrategies } from './strategies.mjs';

const stat = path => lstatSync(path, { throwIfNoEntry: false });
const owned = info => info?.uid === process.getuid();
const attention = 'Needs attention';
const absent = 'Not installed';
const ready = 'OK';

function smallFile(path) {
  const info = stat(path);
  if (!owned(info) || !info.isFile() || info.size > 1024 * 1024) throw new Error('Unreadable setup file.');
  return readFileSync(path, 'utf8');
}

function installedRoot(base, path) {
  if (!isAbsolute(base)) throw new Error('Invalid installation root.');
  const root = join(base, path);
  const info = stat(root);
  if (!info) return;
  if (!owned(info) || !info.isDirectory()) throw new Error('Invalid installation directory.');
  return root;
}

function checkOpenCode() {
  const root = installedRoot(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode/plugins/fm-pcc-router');
  if (!root) return absent;
  const entry = stat(join(root, 'integrations/opencode/index.js'));
  return smallFile(join(root, '.fm-pcc-router-owned')) === 'fm-pcc-router installer ownership marker v1\n'
    && owned(entry) && entry.isFile() ? ready : attention;
}

function codexRegistration() {
  const root = installedRoot(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'fm-pcc-router/codex');
  if (!root) return;
  const record = JSON.parse(smallFile(join(root, '.fm-pcc-router-owned.json')));
  const route = stat(join(root, 'integrations/codex/codex-route.mjs'));
  if (record?.owner !== 'fm-pcc-router' || !owned(route) || !route.isFile()) {
    throw new Error('Invalid Codex installation.');
  }
  return record;
}

function checkCodexHooks(record) {
  if (!record) return 'Not applicable';
  if (typeof record.hooksPath !== 'string' || !isAbsolute(record.hooksPath)) return attention;
  const { hooks } = JSON.parse(smallFile(record.hooksPath));
  const events = ['UserPromptSubmit', 'PostModelRequest'];
  const registered = events.every(event => record.groups?.[event] && Array.isArray(hooks?.[event])
    && hooks[event].some(group => isDeepStrictEqual(group, record.groups[event])));
  return registered ? 'Registered (trust is managed by Codex)' : attention;
}

function checkState(path) {
  const info = stat(path);
  if (!info) return 'Created on first use';
  return owned(info) && info.isDirectory() && (info.mode & 0o077) === 0 ? ready : attention;
}

export async function doctorReport() {
  const report = [];
  const check = async (label, inspect) => {
    let status;
    try { status = await inspect(); } catch { status = attention; }
    report.push(`${label}: ${status}`);
  };

  let codex;
  await check('OpenCode integration', checkOpenCode);
  await check('Codex integration', () => {
    codex = codexRegistration();
    return codex ? ready : absent;
  });
  await check('Codex hooks', () => checkCodexHooks(codex));
  await check('Strategy configuration', async () => {
    await new RoutingStrategies().list();
    return ready;
  });
  await check('Candidate configuration', () => {
    readRoutingConfig('opencode');
    return ready;
  });
  const sessions = defaultSessionRoot();
  await check('Transcript storage', () => checkState(sessions));
  await check('Strategy selection storage', () => checkState(join(dirname(sessions), 'strategy-selections')));
  return report.join('\n');
}
