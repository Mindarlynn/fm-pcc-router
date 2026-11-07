import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const version = 1;
const maxStateBytes = 65_536;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

export function defaultSessionRoot() {
  const configured = process.env.XDG_STATE_HOME;
  return join(configured && isAbsolute(configured) ? configured : join(homedir(), '.local/state'),
    'fm-pcc-router', 'sessions');
}

function sessionKey({ host, sessionID }) {
  if (!['opencode', 'codex'].includes(host) || typeof sessionID !== 'string'
      || !sessionID.trim() || sessionID.length > 256) throw new Error('Invalid PCC chat identity.');
  return digest(JSON.stringify([host, sessionID]));
}

export function routingFingerprint(instructions, payload, schema) {
  return digest(JSON.stringify([instructions, { ...payload, nonce: undefined, currentModel: undefined }, schema]));
}

export function boundedHistory(messages) {
  const result = [];
  let bytes = 0;
  for (const { role, text } of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim()) continue;
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 6000 || result.length === 8) break;
    result.unshift({ role, text });
  }
  return result;
}

function entry(role, text) {
  return {
    id: randomUUID(), role,
    contents: [{ id: randomUUID(), type: 'text', text }],
    ...(role === 'user' ? { options: {}, contextOptions: {} } : {}),
  };
}

// fm's saved-session envelope on macOS 27. Write only FoundationModels.Transcript
// v1.1 text entries; the CLI validates the envelope when it resumes the session.
export function makeTranscript(instructions, history, input) {
  const entries = [entry('instructions', instructions)];
  if (history.length) entries.push(entry('user', JSON.stringify({ history })));
  if (input !== undefined) entries.push(entry('user', JSON.stringify(input)));
  return { modelName: 'pcc', transcript: {
    type: 'FoundationModels.Transcript', version: '1.1', transcript: { entries },
  } };
}

export function transcriptHistory(value) {
  if (value?.modelName !== 'pcc' || value.transcript?.type !== 'FoundationModels.Transcript'
      || value.transcript.version !== '1.1') throw new Error('Invalid saved PCC transcript.');
  const stored = value.transcript.transcript?.entries?.[1];
  if (!stored) return [];
  const parsed = JSON.parse(stored.contents[0].text);
  if (!Array.isArray(parsed.history)) throw new Error('Invalid saved PCC history.');
  return boundedHistory(parsed.history);
}

export async function withSession(root, identity, task) {
  const key = sessionKey(identity);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('The PCC session directory must be private and owned by the current user.');
  }
  const path = join(root, key + '.json');
  const lock = join(root, key + '.lock');
  try {
    // shlock atomically acquires a PID lock and recovers locks left by dead owners.
    await exec('/usr/bin/shlock', ['-p', String(process.pid), '-f', lock], { timeout: 2500 });
  } catch (error) {
    throw new Error('Could not lock the PCC chat state. Retry once the other routing request finishes.', { cause: error });
  }

  try {
    let previous;
    const existing = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.uid !== process.getuid() || (existing.mode & 0o077)
          || existing.size > maxStateBytes) throw new Error('Unsafe saved PCC chat state.');
      if (Date.now() - existing.mtimeMs < maxAgeMs) {
        previous = JSON.parse(await readFile(path, 'utf8'));
        if (previous?.version !== version) throw new Error('Unsupported PCC chat state version.');
      }
    }
    return await task(previous, async (record) => {
      if (record === undefined) {
        await rm(path, { force: true });
        return;
      }
      const content = JSON.stringify({ version, ...record });
      if (Buffer.byteLength(content) > maxStateBytes) throw new Error('PCC chat state exceeded its size limit.');
      const staged = join(root, key + '.' + randomUUID() + '.tmp');
      try {
        await writeFile(staged, content, { mode: 0o600, flag: 'wx' });
        await rename(staged, path);
      } finally {
        await rm(staged, { force: true });
      }
    });
  } finally {
    await rm(lock, { force: true });
  }
}
