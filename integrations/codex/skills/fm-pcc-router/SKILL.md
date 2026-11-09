---
name: fm-pcc-router
description: Route an explicitly requested Codex task through Apple PCC, applying the model and reasoning effort to a supported current CLI chat or a fallback native subagent.
---

Requires macOS 27 with Apple Intelligence and PCC available, Node.js 20 or later, and an installed Codex integration. Current-chat switching is experimental.

Use this workflow when the user asks FM PCC Router to route a task. Preserve explicit model or reasoning choices; do not use routing to override them. Automatic delegation from the prompt hook continues to use the existing subagent workflow.

Resolve the installed integration under `XDG_DATA_HOME/fm-pcc-router/codex`, or `~/.local/share/fm-pcc-router/codex`. If it is missing, report that installation is required. Reuse its `integrations/codex/codex-route.mjs` for every routing decision. Do not recreate or bypass its catalog, candidate limits, strategy, state, validation, audit or `fm respond` logic.

## Explicit task routing

1. Confirm whether the current interface is Codex CLI. Use the live host context or the user's confirmation; a thread's `source` records its origin and does not prove the current interface. Use fallback mode when the interface is the app or is uncertain.
2. Save the single JavaScript recipe below to a private temporary `.mjs` file. Execute it with `node`, passing only the task description on standard input with literal, safely quoted input. Add `--cli` only for a confirmed CLI. Add `--socket /absolute/path` only when the current CLI's local server socket is known; otherwise the recipe checks the default control socket. Keep full chat history, attachments, file contents and credentials out of the input.
3. Use the host's normal approval mechanism for sandbox permission errors. The recipe connects only to an existing private local socket. It never starts or resumes a thread, starts a server, enables features, or edits configuration. Direct mode requires that server to have `step_model_switching` enabled already.
4. Read the JSON result. It calls the existing PCC router once and includes the selected `model`, `effort` and optional `auditId`:
   - `applied`: continue this task in the current chat. Both current-turn publication and future-turn model settings were acknowledged. Already captured steps keep their settings; publication does not guarantee a later inference. Effort is the submitted value. Do not claim the model actually ran without execution evidence.
   - `fallback`: use the returned pair to start one native subagent with an unpinned role, explicit `model` and `reasoning_effort`, and no full-history fork. Pass the task and relevant constraints. Do not call PCC again. If the native tool cannot honor the pair, report that and stop.
   - `stopped`, any routing error or an uncertain write: report the reason and stop the task. Do not create a fallback agent after an uncertain or partial update.
5. Relay the task's result. Reuse the existing optional `codex-audit.mjs verify <auditId> <agentId>` check when the actual executing agent ID and trusted `PostModelRequest` observations are available. For direct mode, do not assume the thread ID is the executing agent ID. Report missing observations as unverified; a settings read or model footer is not execution telemetry. Remove the temporary recipe.

The first skill/PCC steps use the existing model. This workflow switches only when the skill runs; it does not route every ordinary prompt before its first inference. Unsupported standalone CLI or app sessions use the existing subagent path. Do not restart a user's session to force direct mode.

## Temporary execution recipe

The recipe uses Node's standard library and is exercised verbatim by unit tests. It implements the documented WebSocket-over-Unix connection; no new package or persistent helper is installed.

```javascript
import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export async function openRPC(path, timeoutMs = 12000) {
  const socket = connect(path);
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  let buffer = Buffer.alloc(0), ready = false, sequence = 0, fragment = [], fragmentBytes = 0;
  const pending = new Map();
  let resolveOpen, rejectOpen;
  const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  function close(error = new Error('RPC connection closed')) {
    rejectOpen(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear(); socket.destroy();
  }
  function send(data, opcode = 1) {
    const payload = Buffer.from(data); const n = payload.length;
    if (n > 65535) throw new Error('RPC request too large');
    const header = Buffer.alloc(n < 126 ? 6 : 8); header[0] = 0x80 | opcode;
    if (n < 126) header[1] = 0x80 | n;
    else { header[1] = 0x80 | 126; header.writeUInt16BE(n, 2); }
    const mask = randomBytes(4); mask.copy(header, header.length - 4);
    for (let i = 0; i < n; i++) payload[i] ^= mask[i % 4];
    socket.write(Buffer.concat([header, payload]));
  }
  socket.on('error', close); socket.on('close', () => close());
  socket.on('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`));
  socket.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 2 * 1024 * 1024) throw new Error('RPC response too large');
      if (!ready) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) { if (buffer.length > 8192) throw new Error('Invalid handshake'); return; }
        const header = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4);
        const headers = Object.fromEntries(header.split('\r\n').slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
        if (!header.startsWith('HTTP/1.1 101 ') || headers['sec-websocket-accept'] !== accept) throw new Error('Invalid handshake');
        ready = true; resolveOpen();
      }
      while (buffer.length >= 2) {
        const fin = !!(buffer[0] & 128), opcode = buffer[0] & 15;
        if ((buffer[0] & 112) || (buffer[1] & 128)) throw new Error('Invalid frame');
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 2097152n) throw new Error('RPC response too large'); length = Number(n); offset = 10; }
        if (length > 2 * 1024 * 1024 || fragmentBytes + length > 2 * 1024 * 1024) throw new Error('RPC response too large');
        if (opcode >= 8 && (!fin || length > 125)) throw new Error('Invalid control frame');
        if (buffer.length < offset + length) return;
        const body = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
        if (opcode === 8) return close();
        if (opcode === 9) { send(body, 10); continue; }
        if (opcode === 10) continue;
        if (opcode !== 1 && opcode !== 0 || opcode === 0 && !fragment.length || opcode === 1 && fragment.length) throw new Error('Invalid message');
        fragment.push(body); fragmentBytes += length;
        if (!fin) continue;
        const message = JSON.parse(Buffer.concat(fragment).toString('utf8')); fragment = []; fragmentBytes = 0;
        const p = pending.get(message.id); if (!p) continue;
        pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : p.resolve(message.result);
      }
    } catch (error) { close(error); }
  });
  const timer = setTimeout(() => close(new Error('Connection timeout')), timeoutMs);
  try { await opened; } finally { clearTimeout(timer); }
  return {
    call(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send(JSON.stringify({ id, method, params })); } catch (error) { close(error); }
      });
    },
    notify(method) { send(JSON.stringify({ method })); }, close,
  };
}

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const rejected = error => [-32600, -32601, -32602].includes(error.code);
async function liveTurn(rpc, threadId) {
  const { thread } = await rpc.call('thread/read', { threadId, includeTurns: false });
  if (thread.id !== threadId || thread.status?.type !== 'active') throw new Error('The current thread is not active on this server.');
  const { data } = await rpc.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  if (data?.[0]?.status !== 'inProgress') throw new Error('No current live turn was found.');
  return data[0].id;
}
async function enabled(rpc) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const result = await rpc.call('experimentalFeature/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error('Invalid feature catalog.');
    const feature = result.data.find(f => f.name === 'step_model_switching');
    if (feature) return feature.enabled === true;
    if (!result.nextCursor) return false;
    if (seen.has(result.nextCursor)) throw new Error('Invalid feature pagination.');
    cursor = result.nextCursor; seen.add(cursor);
  }
  throw new Error('Feature catalog exceeded its limit.');
}
async function accepts(rpc, route) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const result = await rpc.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error('Invalid model catalog.');
    const model = result.data.find(m => m.id === route.model);
    if (model) return (model.supportedReasoningEfforts ?? []).some(e => (e.reasoningEffort ?? e) === route.effort);
    if (!result.nextCursor) return false;
    if (seen.has(result.nextCursor)) throw new Error('Invalid model pagination.');
    cursor = result.nextCursor; seen.add(cursor);
  }
  throw new Error('Model catalog exceeded its limit.');
}

export async function runSkill(task, { cli = false, socketPath } = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  let routeTask = dependencies.routeTask, audit = dependencies.audit;
  if (!routeTask) {
    const root = join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'fm-pcc-router/codex/integrations/codex');
    ({ chooseCodexRoute: routeTask } = await import(pathToFileURL(join(root, 'codex-route.mjs'))));
    ({ beginCodexAudit: audit } = await import(pathToFileURL(join(root, 'codex-audit.mjs'))));
  }
  const threadId = env.CODEX_THREAD_ID;
  let rpc, turnId, reason = 'A current CLI session was not confirmed.';
  try {
    if (cli && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId ?? '')) {
      try {
        const path = socketPath ?? join(env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock');
        if (!isAbsolute(path)) throw new Error('The server socket must be an absolute path.');
        const stat = dependencies.stat ?? lstat;
        const privateDirectory = info => info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077);
        if (!privateDirectory(await stat(dirname(path)))) throw new Error('The server socket alias must be inside a private owned directory.');
        const target = await (dependencies.realpath ?? realpath)(path);
        const info = await stat(target);
        if (!info.isSocket() || info.uid !== process.getuid() || !privateDirectory(await stat(dirname(target))))
          throw new Error('The resolved server socket must be owned by this user inside a private owned directory.');
        rpc = await (dependencies.open ?? openRPC)(target);
        await rpc.call('initialize', { clientInfo: { name: 'fm_pcc_router_skill', version: '0.5.2-experimental' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized');
        if (!await enabled(rpc)) throw new Error('step_model_switching is not enabled on the existing server.');
        turnId = await liveTurn(rpc, threadId);
      } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) throw error;
        reason = error.message;
        rpc?.close(); rpc = undefined;
      }
    }
    // All model selection, PCC transport, strategies and state remain in the existing router.
    const route = await routeTask(task);
    const result = { ...route, auditId: audit?.(route.model), threadId, execution: 'unverified' };
    if (!rpc) return { ...result, status: 'fallback', reason };
    if (!await accepts(rpc, route)) return { ...result, status: 'fallback', reason: 'The selected pair is unavailable on the current server.' };
    if (await liveTurn(rpc, threadId) !== turnId) return { ...result, status: 'stopped', reason: 'The live turn changed while routing.' };
    let update;
    try {
      update = await rpc.call('turn/settings/update', { threadId, turnId, model: route.model, effort: route.effort });
    } catch (error) {
      if (rejected(error)) return { ...result, status: 'fallback', reason: error.message };
      return { ...result, status: 'stopped', reason: 'The turn update outcome is unknown: ' + error.message };
    }
    if (update?.status === 'targetUnavailable') return { ...result, status: 'stopped', reason: 'The target turn ended before publication.' };
    if (update?.status !== 'applied') return { ...result, status: 'stopped', reason: 'Unexpected turn update response.' };
    try {
      await rpc.call('thread/settings/update', { threadId, model: route.model, effort: route.effort });
      const { thread } = await rpc.call('thread/read', { threadId, includeTurns: false });
      if (thread.id !== threadId || thread.model !== route.model) throw new Error('The saved thread model did not match.');
      return { ...result, status: 'applied', turnId, effortStatus: 'submitted' };
    } catch (error) {
      return { ...result, status: 'stopped', turnId, reason: 'The live turn was updated, but future-turn settings are unverified: ' + error.message };
    }
  } finally { rpc?.close(); }
}

if (import.meta.url.startsWith('file:') && process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { cli: { type: 'boolean' }, socket: { type: 'string' } } });
    let task = '', bytes = 0;
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 24576) throw new Error('Task input exceeds the 24 KB limit.');
      task += chunk;
    }
    const result = await runSkill(task, { cli: values.cli, socketPath: values.socket });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
```
