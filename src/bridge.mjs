import { mkdtemp, chmod, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requestJSON } from './http.mjs';
import { launchTerminalServer, stopTerminalServer } from './terminal.mjs';

export function validatePCCReply(response, nonce) {
  if (response?.model !== 'pcc') throw new Error('Rejected a response from a model other than PCC.');
  if (response.choices?.length !== 1 || response.choices[0].finish_reason !== 'stop') {
    throw new Error('The PCC response did not complete.');
  }
  const message = response.choices[0].message;
  if (message?.refusal) throw new Error('PCC refused the test request.');
  let result;
  try { result = JSON.parse(message.content); } catch {
    throw new Error('The PCC test response contains invalid JSON.');
  }
  if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'nonce,ok'
      || result.ok !== true || result.nonce !== nonce) {
    throw new Error('The PCC test response does not match the current request.');
  }
  return { model: 'pcc', ok: true };
}

export class PCCBridge {
  constructor({ launch = launchTerminalServer, stop = stopTerminalServer,
    request = requestJSON, checkAvailable = () => access('/usr/bin/fm'),
    tempRoot = '/private/tmp', startupMs = 15_000 } = {}) {
    this.launch = launch;
    this.stopServer = stop;
    this.request = request;
    this.checkAvailable = checkAvailable;
    this.tempRoot = tempRoot;
    this.startupMs = startupMs;
    this.lifetime = new AbortController();
    this.queue = Promise.resolve();
    this.starting = undefined;
    this.state = undefined;
    this.disposing = undefined;
  }

  async ensureStarted() {
    this.lifetime.signal.throwIfAborted();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.checkAvailable();
      const dir = await mkdtemp(join(this.tempRoot, 'oc-pcc-'));
      await chmod(dir, 0o700);
      const state = { dir, socket: join(dir, 'fm.sock'), label: `OpenCode PCC ${randomUUID()}` };
      this.state = state;
      await this.launch(state, this.lifetime.signal);
      const deadline = Date.now() + this.startupMs;
      while (true) {
        this.lifetime.signal.throwIfAborted();
        let health;
        try {
          health = await this.request(state.socket, '/health', {
            signal: this.lifetime.signal, timeoutMs: 1000,
          });
        } catch (error) {
          this.lifetime.signal.throwIfAborted();
          if (Date.now() >= deadline) throw new Error('Timed out waiting for the PCC server to become ready.', { cause: error });
          await delay(100, undefined, { signal: this.lifetime.signal });
          continue;
        }
        const model = health?.models?.find((m) => m.name === 'pcc');
        if (!model?.available || model.quota?.limit_reached) {
          throw new Error('PCC is unavailable. Check Apple Intelligence settings and usage limits.');
        }
        return state;
      }
    })().catch(async (error) => {
      await this.cleanup();
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  complete(body) {
    if (body?.model !== 'pcc' || body.stream !== false) {
      return Promise.reject(new Error('Only non-streaming PCC requests are allowed.'));
    }
    const task = this.queue.then(async () => {
      this.lifetime.signal.throwIfAborted();
      const state = await this.ensureStarted();
      return this.request(state.socket, '/v1/chat/completions', {
        signal: this.lifetime.signal,
        body,
      });
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async probe() {
      const nonce = randomUUID();
      const started = Date.now();
      const response = await this.complete({
          model: 'pcc', stream: false,
          messages: [{ role: 'user', content: `Connection test. Return ok true and nonce ${nonce}.` }],
          response_format: { type: 'json_schema', json_schema: {
            name: 'ConnectionProbe', strict: true, schema: {
              type: 'object', additionalProperties: false, required: ['ok', 'nonce'],
              properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } },
            },
          } },
      });
      return { ...validatePCCReply(response, nonce), elapsedMs: Date.now() - started };
  }

  async cleanup() {
    const state = this.state;
    if (!state) return;
    await this.stopServer(state);
    await rm(state.dir, { recursive: true, force: true });
    this.state = undefined;
  }

  dispose() {
    if (this.disposing) return this.disposing;
    this.lifetime.abort(new Error('The PCC test plugin was shut down.'));
    this.disposing = (async () => {
      await this.queue;
      await this.starting?.catch(() => {});
      await this.cleanup();
    })();
    return this.disposing;
  }
}
