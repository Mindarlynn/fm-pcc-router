import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIT_TTL_MS = 30 * 60_000;
const MAX_RECORDS = 64;
const statuses = new Set(['completed', 'failed', 'cancelled']);
const isID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const isModel = value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const defaultRoot = () => '/private/tmp/fm-pcc-audit-' + process.getuid();
const unverified = () => ({ status: 'unverified' });

function privateDirectory(path) {
  const info = lstatSync(path);
  return info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0;
}

function readState(directory) {
  try {
    if (!privateDirectory(directory)) return undefined;
    const state = JSON.parse(readFileSync(join(directory, 'route.json'), 'utf8'));
    if (isID(state.auditId) && isModel(state.model) && Number.isFinite(state.expiresAt)) return state;
  } catch {}
  return undefined;
}

export function beginCodexAudit(model, {
  sessionId = process.env.CODEX_THREAD_ID, root = defaultRoot(), now = Date.now(),
} = {}) {
  if (!isID(sessionId) || !isModel(model)) return undefined;
  try {
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!privateDirectory(root)) return undefined;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
      const directory = join(root, entry.name);
      const state = readState(directory);
      if (state && state.expiresAt <= now) rmSync(directory, { recursive: true, force: true });
    }

    const directory = join(root, digest(sessionId));
    const auditId = randomUUID();
    mkdirSync(directory, { mode: 0o700 });
    try {
      writeFileSync(join(directory, 'route.json'), JSON.stringify({
        auditId, model, expiresAt: now + AUDIT_TTL_MS,
      }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return auditId;
  } catch { return undefined; }
}

export function recordCodexModel(event, { root = defaultRoot(), now = Date.now() } = {}) {
  if (event?.hook_event_name !== 'PostModelRequest' || !isID(event.session_id)
      || !isID(event.agent_id) || !isModel(event.model) || !statuses.has(event.status)) return;
  try {
    if (!privateDirectory(root)) return;
    const directory = join(root, digest(event.session_id));
    const state = readState(directory);
    if (!state || state.expiresAt <= now) return;
    // Record only the model and outcome. Repeated attempts with the same values share a record.
    const name = [state.auditId, digest(event.agent_id), digest(event.model), event.status].join('.');
    const existing = readdirSync(directory);
    if (existing.includes(name)) return;
    if (existing.length > MAX_RECORDS) {
      writeFileSync(join(directory, 'overflow'), '', { mode: 0o600, flag: 'wx' });
      return;
    }
    writeFileSync(join(directory, name), event.model, { mode: 0o600, flag: 'wx' });
  } catch {}
}

export function verifyCodexAudit(auditId, agentId, {
  sessionId = process.env.CODEX_THREAD_ID, root = defaultRoot(), now = Date.now(),
} = {}) {
  if (!isID(sessionId) || !isID(auditId) || !isID(agentId)) return unverified();
  try {
    if (!privateDirectory(root)) return unverified();
    const directory = join(root, digest(sessionId));
    const state = readState(directory);
    if (state?.auditId !== auditId) return unverified();
    try {
      if (state.expiresAt <= now) return unverified();
      const prefix = auditId + '.' + digest(agentId) + '.';
      const observed = new Set();
      let completed = false;
      let overflow = false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'overflow') overflow = true;
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const model = readFileSync(join(directory, entry.name), 'utf8');
        if (!isModel(model)) continue;
        observed.add(model);
        if (entry.name.endsWith('.completed')) completed = true;
      }
      const models = [...observed].sort();
      const status = models.some(model => model !== state.model) ? 'mismatch' : completed && !overflow ? 'match' : 'unverified';
      return { status, selectedModel: state.model, observedModels: models };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } catch { return unverified(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'verify') {
    console.log(JSON.stringify(verifyCodexAudit(process.argv[3], process.argv[4])));
  } else if (process.argv[2] === 'observe') {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 32_768) break;
        chunks.push(chunk);
      }
      if (bytes <= 32_768) recordCodexModel(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {}
  }
}
