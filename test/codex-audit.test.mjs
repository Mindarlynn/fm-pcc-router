import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { beginCodexAudit, recordCodexModel, verifyCodexAudit } from '../integrations/codex/codex-audit.mjs';

const selected = 'gpt-6.1-sol';
const event = {
  hook_event_name: 'PostModelRequest',
  session_id: 'main-session',
  agent_id: 'selected-child',
  model: selected,
  status: 'completed',
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-pcc-audit-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root: join(dir, 'audit'), sessionId: event.session_id, now: 1000 };
}

test('audit matches only the selected subagent in an armed session', async t => {
  const opts = await fixture(t);
  recordCodexModel(event, opts);
  await assert.rejects(readdir(opts.root), { code: 'ENOENT' });
  const id = beginCodexAudit(selected, opts);
  recordCodexModel({ ...event, agent_id: undefined, model: 'unrelated-model' }, opts);
  recordCodexModel({ ...event, session_id: 'other-session', model: 'unrelated-model' }, opts);
  recordCodexModel({ ...event, agent_id: 'other-child', model: 'unrelated-model' }, opts);
  recordCodexModel(event, opts);
  assert.deepEqual(verifyCodexAudit(id, event.agent_id, opts), {
    status: 'match', selectedModel: selected, observedModels: [selected],
  });
  assert.deepEqual(await readdir(opts.root), []);
});

test('audit reports a different observed model even after a matching attempt', async t => {
  const opts = await fixture(t);
  const id = beginCodexAudit(selected, opts);
  recordCodexModel(event, opts);
  recordCodexModel({ ...event, model: 'gpt-6-luna' }, opts);
  assert.deepEqual(verifyCodexAudit(id, event.agent_id, opts), {
    status: 'mismatch', selectedModel: selected, observedModels: ['gpt-6-luna', selected],
  });
});

test('missing or failed-only observations cannot verify execution', async t => {
  const opts = await fixture(t);
  const id = beginCodexAudit(selected, opts);
  recordCodexModel({ ...event, status: 'failed' }, opts);
  assert.equal(verifyCodexAudit('wrong-id', event.agent_id, opts).status, 'unverified');
  assert.equal(verifyCodexAudit(id, event.agent_id, opts).status, 'unverified');
  const fresh = beginCodexAudit(selected, opts);
  assert.equal(verifyCodexAudit(fresh, event.agent_id, opts).status, 'unverified');
});

test('expired observations cannot verify a later route', async t => {
  const opts = await fixture(t);
  const id = beginCodexAudit(selected, opts);
  recordCodexModel(event, opts);
  const later = { ...opts, now: opts.now + 31 * 60_000 };
  const next = beginCodexAudit(selected, later);
  assert.notEqual(next, id);
  assert.equal(verifyCodexAudit(id, event.agent_id, later).status, 'unverified');
  assert.equal(verifyCodexAudit(next, event.agent_id, later).status, 'unverified');
});
