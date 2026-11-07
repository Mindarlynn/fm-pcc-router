#!/usr/bin/env node
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRoutingRequest, parseRoutingResponse, buildCatalog } from '../../src/routing.mjs';
import { PCCBridge } from '../../src/bridge.mjs';
import { beginCodexAudit } from './codex-audit.mjs';

export const MAX_TASK_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_PROTOCOL_BYTES = 512 * 1024;
const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const SUBAGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function routeError(message) { return new Error(message); }

export function validateTask(task) {
  if (typeof task !== 'string' || !task.trim()) throw routeError('Task input must not be empty.');
  if (Buffer.byteLength(task, 'utf8') > MAX_TASK_BYTES) throw routeError('Task input exceeds the 24 KB limit.');
  return task;
}

function positiveInteger(value) { return Number.isInteger(value) && value > 0; }

export function mapCodexModels(models) {
  if (!Array.isArray(models)) throw routeError('Codex returned an invalid model catalog.');
  const seen = new Set();
  const clean = [];
  for (const model of models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim() ||
        model.hidden === true || model.isVisible === false) continue;
    const id = model.id.trim();
    if (seen.has(id)) throw routeError('Codex returned duplicate model identifiers.');
    seen.add(id);
    const supported = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ?? [];
    if (!Array.isArray(supported)) throw routeError('Codex returned invalid reasoning effort metadata.');
    const efforts = [];
    for (const item of supported) {
      const effort = typeof item === 'string' ? item : item?.reasoningEffort ?? item?.reasoning_effort;
      if (SUBAGENT_EFFORTS.has(effort) && !efforts.includes(effort)) efforts.push(effort);
    }
    if (efforts.length === 0) continue;
    clean.push({
      enabled: true, type: 'chat', providerID: 'codex', id,
      ...(typeof model.displayName === 'string' && model.displayName.trim() ? { name: model.displayName.trim().slice(0, 160) } : {}),
      capabilities: {
        input: Array.isArray(model.inputModalities) ? model.inputModalities.filter(x => x === 'text') : ['text'],
        output: ['text'], tools: false,
      },
      ...(positiveInteger(model.contextWindow) ? { limit: { context: model.contextWindow } } : {}),
      variants: efforts.map(effort => ({ id: effort })),
    });
  }
  return clean;
}

class AppServer {
  constructor({ executable, spawn = spawnChild, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_PROTOCOL_BYTES }) {
    this.executable = executable;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.child = undefined;
    this.nextId = 0;
    this.pending = new Map();
    this.outputBytes = 0;
    this.closed = false;
    this.deadline = 0;
  }

  async start() {
    this.deadline = Date.now() + this.timeoutMs;
    this.child = this.spawn(this.executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child.on('error', () => this.failAll(routeError('Could not start the Codex app-server.')));
    this.child.on('close', () => { this.closed = true; this.failAll(routeError('The Codex app-server stopped unexpectedly.')); });
    this.child.stdin.on('error', () => this.failAll(routeError('Could not send a request to the Codex app-server.')));
    this.child.stdout.on('data', chunk => {
      this.outputBytes += Buffer.byteLength(chunk);
      if (this.outputBytes <= this.maxOutputBytes || this.closed) return;
      this.failAll(routeError('Codex app-server output exceeded the size limit.'));
      this.stop().catch(() => {});
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.onLine(line));
    try {
      await this.call('initialize', { clientInfo: { name: 'fm_pcc_router', title: 'FM PCC Router', version: '1' } });
      this.notify('initialized', {});
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  onLine(line) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(line); } catch {
      this.failAll(routeError('Codex app-server returned malformed protocol data.'));
      return;
    }
    if (!message || typeof message !== 'object' || !('id' in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error || !('result' in message)) pending.reject(routeError('Codex app-server rejected a request.'));
    else pending.resolve(message.result);
  }

  write(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw routeError('Codex app-server is unavailable.');
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > 16 * 1024) throw routeError('Codex app-server request exceeded the size limit.');
    this.child.stdin.write(line);
  }

  call(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const remaining = Math.min(this.timeoutMs, this.deadline - Date.now());
      if (remaining <= 0) { reject(routeError('Timed out waiting for the Codex app-server.')); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(routeError('Timed out waiting for the Codex app-server.')); }, remaining);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  async listModels() {
    const all = [];
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < 100; page++) {
      const result = await this.call('model/list', { ...(cursor ? { cursor } : {}), includeHidden: false });
      if (!result || !Array.isArray(result.data ?? result.models)) throw routeError('Codex returned an invalid model catalog.');
      all.push(...(result.data ?? result.models));
      if (all.length > 5000) throw routeError('Codex model catalog exceeded the size limit.');
      const next = result.nextCursor ?? result.next_cursor;
      if (next == null || next === '') return all;
      if (typeof next !== 'string' || cursors.has(next)) throw routeError('Codex returned invalid model pagination data.');
      cursors.add(next);
      cursor = next;
    }
    throw routeError('Codex model catalog exceeded the pagination limit.');
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    const exited = this.closed;
    this.child = undefined;
    this.closed = true;
    this.failAll(routeError('Codex app-server was stopped.'));
    if (exited) return;
    const closed = once(child, 'close').then(() => true, () => true);
    child.kill('SIGTERM');
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); });
    if (!await Promise.race([closed, timeout])) child.kill('SIGKILL');
    clearTimeout(timer);
  }
}

async function resolveExecutable() {
  const { access } = await import('node:fs/promises');
  try { await access(BUNDLED_CODEX); return BUNDLED_CODEX; } catch {}
  return 'codex';
}

export async function getCodexCatalog({ executable, spawn = spawnChild, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_PROTOCOL_BYTES } = {}) {
  const app = new AppServer({ executable: executable ?? await resolveExecutable(), spawn, timeoutMs, maxOutputBytes });
  await app.start();
  try { return mapCodexModels(await app.listModels()); }
  finally { await app.stop(); }
}

export async function chooseCodexRoute(task, { getModels = getCodexCatalog, bridge, nonce = randomUUID() } = {}) {
  validateTask(task);
  const pcc = bridge ?? new PCCBridge();
  try {
    const models = await getModels();
    const catalog = buildCatalog(models, { requiredInputs: ['text'], requireTools: false, allowedProviders: ['codex'] })
      // A delegation must name an explicit effort even when it matches the model default.
      .map(model => ({ ...model, routes: model.routes.filter(route => SUBAGENT_EFFORTS.has(route.variant)) }))
      .filter(model => model.routes.length > 0);
    if (!catalog.length) throw routeError('No Codex model and reasoning effort pairs are available for delegation.');
    const body = createRoutingRequest({ text: task, catalog, nonce });
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_TASK_BYTES) throw routeError('Routing request exceeds the 24 KB limit.');
    const response = await pcc.complete(body);
    const parsed = parseRoutingResponse(response, catalog, nonce);
    return { model: parsed.model.id, effort: parsed.model.variant, reason: parsed.reason };
  } finally {
    if (!bridge) await pcc.dispose();
  }
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let data = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_TASK_BYTES) throw routeError('Task input exceeds the 24 KB limit.');
    data += chunk;
  }
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv[2] === '--user-prompt-submit') {
    // Drain the hook input without parsing or retaining the user's prompt.
    for await (const _chunk of process.stdin) {}
    const workflow = fileURLToPath(new URL('./routing.md', import.meta.url));
    const additionalContext = [
      'Apply FM PCC Router only if you are already going to create a native subagent.',
      'Respect explicit model or reasoning effort choices, and use your normal delegation rules.',
      `Before spawning an eligible subagent, read the PCC routing workflow at ${JSON.stringify(workflow)}.`,
      'Pass only the delegated task description to the router and supply its selected model and reasoning effort explicitly at spawn.',
    ].join(' ');
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })}\n`);
  } else {
    try {
      const task = await readStdin();
      const route = await chooseCodexRoute(task);
      const auditId = process.argv.includes('--audit') ? beginCodexAudit(route.model) : undefined;
      process.stdout.write(`${JSON.stringify({ ...route, auditId })}\n`);
    }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Codex routing failed.'}\n`); process.exitCode = 1; }
  }
}
