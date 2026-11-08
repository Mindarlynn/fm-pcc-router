import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, createRoutingRequest, parseRoutingResponse, fitRoutingRequest } from '../src/routing.mjs';
import { applyModelScope } from '../src/routing-config.mjs';

const nonce = 'current-request';
const base = { enabled: true, type: 'chat', providerID: 'new-provider', id: 'shared', name: 'Future',
  capabilities: { input: ['text', 'pdf'], output: ['text'], tools: true },
  limit: { context: 1000, input: 900, output: 100 }, variants: [{ id: 'deep', body: 'SECRET' }],
  headers: { Authorization: 'SECRET' }, cost: [] };
const catalog = buildCatalog([base, { ...base, providerID: 'other-provider' }]);
const make = (extra = {}) => createRoutingRequest({ text: 'test task', catalog, nonce, ...extra });
const decision = { nonce, reason: 'Matches the requested variant.', route_id: catalog[1].routes[1].route_id };
const wrap = content => ({ model: 'pcc', choices: [{ finish_reason: 'stop', message: { content } }] });
const parse = response => parseRoutingResponse(response, catalog, nonce);

test('unknown providers with colliding model names and exact variants remain addressable', () => {
  assert.deepEqual(parse(wrap(JSON.stringify(decision))).model, { providerID: 'other-provider', id: 'shared', variant: 'deep' });
  assert.deepEqual(parse(wrap(JSON.stringify({ ...decision, route_id: catalog[0].routes[0].route_id }))).model, { providerID: 'new-provider', id: 'shared' });
  assert.deepEqual(make().response_format.json_schema.schema.properties.route_id.enum, catalog.flatMap(m => m.routes.map(r => r.route_id)));
});

test('eligibility checks connection policy, chat capabilities, tool use and context limits', () => {
  const invalid = [{ enabled: false }, { type: 'embedding' }, { limit: {} }, { limit: { context: 999 } },
    ...[{ tools: false }, { output: [] }, { input: ['text'] }].map(c => ({ capabilities: { ...base.capabilities, ...c } }))];
  const options = { requiredInputs: ['text', 'pdf'], minContextTokens: 1000, allowedProviders: [base.providerID] };
  const available = [base, { ...base, providerID: 'built-in-free' }, ...invalid.map((c, i) => ({ ...base, id: 'skip' + i, ...c }))];
  assert.deepEqual(buildCatalog(available, options), [catalog[0]]);
  assert.throws(() => make({ catalog: buildCatalog(available, { allowedProviders: [] }) }), /No eligible/);
});

test('sends only safe metadata and keeps task and preference in a data message', () => {
  const priced = { ...base, cost: [{ input: 0, output: 2, settings: 'SECRET' }] };
  const body = make({ catalog: buildCatalog([base, { ...priced, id: 'priced' }]), text: 'INJECT_TEST_PAYLOAD', preference: 'latency',
    context: [{ role: 'assistant', text: 'history', headers: 'SECRET' }], currentModel: { id: base.id, body: 'SECRET' } });
  assert.doesNotMatch(JSON.stringify(body), /SECRET/);
  assert.match(body.messages[0].content, /untrusted/);
  assert.match(body.messages[0].content, /NOT an explicit user request/);
  assert.doesNotMatch(body.messages[0].content, /INJECT_TEST_PAYLOAD/);
  const payload = JSON.parse(body.messages[1].content);
  assert.equal(payload.preference, 'latency');
  assert.equal(payload.catalog[0].cost, 'unknown');
  assert.deepEqual(payload.catalog[1].cost, [{ input: 0, output: 2 }]);
});

test('rejects stale, incomplete, unrecognized and malformed responses', () => {
  for (const fields of [{ nonce: 'stale' }, { route_id: 'invented' }, { route_id: 1 }, { reason: ' ' }, { reason: 'a'.repeat(241) }, { extra: true }])
    assert.throws(() => parse(wrap(JSON.stringify({ ...decision, ...fields }))));
  for (const malformed of ['[]', 'null', '{']) assert.throws(() => parse(wrap(malformed)));
  for (const mutate of [r => { r.model = 'local'; }, r => { r.choices[0].finish_reason = 'length'; }, r => { r.choices[0].message.refusal = 'declined'; }]) {
    const response = wrap(JSON.stringify(decision));
    mutate(response);
    assert.throws(() => parse(response));
  }
});

test('fails oversized tasks and catalogs without clipping', () => {
  assert.throws(() => make({ text: 'a'.repeat(100000) }), /size limit/);
  const many = buildCatalog(Array.from({ length: 1100 }, (_, i) => ({ ...base, id: 'model-' + i })));
  assert.throws(() => make({ catalog: many }), /size limit/);
});

test('candidate scope caps providers and protects an unambiguous explicit model', () => {
  const models = buildCatalog(Array.from({ length: 4 }, (_, i) => ({ ...base, providerID: i < 2 ? 'a' : 'b', id: `m${i}` })));
  const scoped = applyModelScope(models, { maxModelsPerProvider: 1 }, 'Please use m1 for this task.');
  assert.deepEqual(scoped.map(m => m.id), ['m1', 'm2']);
  assert.deepEqual(applyModelScope(models, { models: [{ providerID: 'a', id: 'm0' }] }, 'Use m1.').map(m => m.id), ['m0']);
  assert.throws(() => applyModelScope(models, { maxModelsPerProvider: 1 }, 'Compare m0 and m1.'), /exceed maxModelsPerProvider/);
});

test('fitting compacts labels first and keeps every model when the compact request fits', () => {
  const options = { text: 'Hi', catalog, nonce };
  const bytes = Buffer.byteLength(JSON.stringify(createRoutingRequest(options)));
  assert.deepEqual(fitRoutingRequest(options, { maxBytes: bytes }).catalog, catalog);
  const fitted = fitRoutingRequest(options, { maxBytes: bytes - 1 });
  assert.equal(fitted.catalog.length, catalog.length);
  assert(fitted.catalog.every(model => !Object.hasOwn(model, 'name')));
});

test('even catalogs over the original request cap fit deterministically with provider coverage and exact routes', () => {
  const models = buildCatalog(Array.from({ length: 1100 }, (_, i) => ({ ...base, providerID: i % 3 ? 'a' : 'b', id: `large-model-${i}` })));
  const options = { text: 'Use b/large-model-1098.', catalog: models, nonce };
  const one = fitRoutingRequest(options);
  assert.deepEqual(one, fitRoutingRequest(options));
  assert(one.catalog.length < models.length);
  assert.deepEqual(new Set(one.catalog.map(model => model.providerID)), new Set(['a', 'b']));
  assert(one.catalog.some(model => model.id === 'large-model-1098'));
  assert(Buffer.byteLength(JSON.stringify(one.body)) <= 24_000);
  assert.deepEqual(one.body.response_format.json_schema.schema.properties.route_id.enum,
    one.catalog.flatMap(model => model.routes.map(route => route.route_id)));
  assert.throws(() => fitRoutingRequest({ ...options, text: 'a'.repeat(25_000) }), /context budget/);
});

test('the shortlist fills an uncovered provider before adding another model for a named model’s provider', () => {
  const models = buildCatalog([
    { ...base, providerID: 'a', id: 'first' }, { ...base, providerID: 'a', id: 'named' },
    { ...base, providerID: 'b', id: 'other' },
  ]);
  const options = { text: 'Use a/named.', nonce, catalog: models };
  const compactPair = models.slice(1).map(({ name, family, status, ...model }) => model);
  const maxBytes = Buffer.byteLength(JSON.stringify(createRoutingRequest({ ...options, catalog: compactPair })));
  assert.deepEqual(fitRoutingRequest(options, { maxBytes }).catalog.map(model => model.id), ['named', 'other']);
});
