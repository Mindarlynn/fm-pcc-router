import { randomUUID } from 'node:crypto';
import { parseRoutingResponse } from './routing.mjs';
import { respondInTerminal } from './terminal.mjs';
import {
  boundedHistory, defaultSessionRoot, makeTranscript, routingFingerprint, transcriptHistory, withSession,
} from './session.mjs';

const response = decision => ({ model: 'pcc', choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify(decision) } }] });

export function validatePCCReply(reply, nonce) {
  if (reply?.model !== 'pcc' || reply.choices?.length !== 1 || reply.choices[0].finish_reason !== 'stop'
      || reply.choices[0].message?.refusal) throw new Error('The PCC connection test did not complete.');
  let decision;
  try { decision = JSON.parse(reply.choices[0].message.content); } catch {
    throw new Error('The PCC test response contains invalid JSON.');
  }
  if (!decision || Object.keys(decision).sort().join(',') !== 'nonce,ok'
      || decision.ok !== true || decision.nonce !== nonce) {
    throw new Error('The PCC test response does not match the current request.');
  }
  return { model: 'pcc', ok: true };
}

export class PCCBridge {
  constructor({ respond = respondInTerminal, sessionRoot = defaultSessionRoot() } = {}) {
    this.respond = respond;
    this.sessionRoot = sessionRoot;
    this.lifetime = new AbortController();
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  complete(body, identity) {
    if (body?.model !== 'pcc' || body.stream !== false) {
      return Promise.reject(new Error('Only non-streaming PCC requests are allowed.'));
    }
    return this.enqueue(async () => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      const [system, user] = body.messages;
      const payload = JSON.parse(user.content);
      const schema = body.response_format.json_schema.schema;
      const context = Array.isArray(payload.context) ? boundedHistory(payload.context) : [];
      const fingerprint = routingFingerprint(system.content, payload, schema);
      const route = async (previous, commit) => {
        signal.throwIfAborted();
        const messageID = identity?.messageID;
        if (messageID !== undefined && (typeof messageID !== 'string' || !messageID.trim() || messageID.length > 256)) {
          throw new Error('Invalid PCC routing message ID.');
        }
        const older = previous?.older ?? [];
        if (messageID && older.includes(messageID)) throw new Error('This chat message has already been superseded.');
        if (messageID && previous?.messageID === messageID && previous.fingerprint === fingerprint) {
          const cached = response({ ...previous.decision, nonce: payload.nonce });
          parseRoutingResponse(cached, payload.catalog, payload.nonce);
          return cached;
        }
        // OpenCode's current chat snapshot wins after edits, branches, or compaction.
        // Codex only persists previous delegated task descriptions.
        let history = identity?.host === 'codex' && previous ? transcriptHistory(previous.transcript) : context;
        const current = { ...payload, context: undefined };
        const inputSize = () => Buffer.byteLength(JSON.stringify([system.content, history, current, schema]));
        while (history.length && inputSize() > 24_000) history = history.slice(1);
        if (inputSize() > 24_000) throw new Error('The PCC routing input exceeds the safe context budget.');
        const transcript = makeTranscript(system.content, history, current);
        const decision = await this.respond(transcript, schema, signal);
        const reply = response(decision);
        parseRoutingResponse(reply, payload.catalog, payload.nonce);
        signal.throwIfAborted();
        if (commit) {
          const nextHistory = boundedHistory([...history, { role: 'user', text: payload.text }]);
          const replaced = previous?.messageID && previous.messageID !== messageID ? [previous.messageID] : [];
          await commit({ messageID, fingerprint, decision, older: [...older, ...replaced].slice(-16),
            transcript: makeTranscript(system.content, nextHistory) });
        }
        return reply;
      };
      return identity ? withSession(this.sessionRoot, identity, route) : route();
    });
  }

  forget(identity) {
    return this.enqueue(() => withSession(this.sessionRoot, identity, (_previous, commit) => commit()));
  }

  probe() {
    return this.enqueue(async () => {
      const nonce = randomUUID();
      const started = Date.now();
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      const transcript = makeTranscript('Return the requested JSON exactly.', [], { ok: true, nonce });
      const schema = { type: 'object', additionalProperties: false, required: ['ok', 'nonce'],
        properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } } };
      const result = await this.respond(transcript, schema, signal);
      return { ...validatePCCReply(response(result), nonce), elapsedMs: Date.now() - started };
    });
  }

  dispose() {
    this.lifetime.abort(new Error('The PCC router was shut down.'));
    return this.queue;
  }
}
