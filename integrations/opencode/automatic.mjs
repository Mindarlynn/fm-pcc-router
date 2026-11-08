import { randomUUID } from 'node:crypto';
import { buildCatalog, fitRoutingRequest, parseRoutingResponse } from '../../src/routing.mjs';
import { readRoutingConfig, applyModelScope } from '../../src/routing-config.mjs';

const variantRef = (variant) => variant == null || variant === '' || variant === 'default' ? '' : variant;
const sameRef = (a, b) => a?.providerID === b?.providerID && a?.id === b?.id
  && variantRef(a?.variant) === variantRef(b?.variant);
const rows = (value) => Array.isArray(value) ? value : value?.data ?? [];
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const isBusy = (session) => typeof session.time?.busy === 'number'
  && (typeof session.time?.idle !== 'number' || session.time.busy > session.time.idle);

function textOf(message) {
  if (message.type === 'user' || message.type === 'compaction') return message.text ?? message.summary ?? '';
  if (message.type === 'assistant') return (message.content ?? [])
    .filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  return '';
}

export function routingContext(messages) {
  const context = [];
  let bytes = 0;
  for (const message of [...messages].reverse()) {
    if (!['user', 'assistant', 'compaction'].includes(message.type)) continue;
    const text = textOf(message);
    if (!text) continue;
    if (bytes + byteLength(text) > 6000 || context.length >= 8) break;
    context.unshift({ role: message.type === 'assistant' ? 'assistant' : 'user', text });
    bytes += byteLength(text);
  }
  return context;
}

export function requiredInputs(files = []) {
  const result = new Set(['text']);
  for (const file of files) {
    const name = `${file.mime ?? ''} ${file.name ?? ''} ${file.uri?.split('?')[0] ?? ''}`.toLowerCase();
    if (/image\/|\.(png|jpe?g|gif|webp|heic|bmp|tiff?|avif)(?:$|\s)/.test(name)) result.add('image');
    if (/application\/pdf|\.pdf(?:$|\s)/.test(name)) result.add('pdf');
    if (/audio\/|\.(mp3|wav|m4a|ogg|flac|aac)(?:$|\s)/.test(name)) result.add('audio');
    if (/video\/|\.(mp4|mov|webm|mkv)(?:$|\s)/.test(name)) result.add('video');
  }
  return [...result];
}

export function validateOptions(options = {}) {
  const allowed = options.allowedProviders;
  if (allowed !== undefined && (!Array.isArray(allowed)
      || !allowed.every((id) => typeof id === 'string' && id.trim() && id.length <= 256))) {
    throw new Error('allowedProviders must be an array of provider IDs.');
  }
  const preference = options.preference ?? 'balanced';
  if (!['balanced', 'quality', 'economy'].includes(preference)) throw new Error('Invalid routing preference.');
  return { allowedProviders: allowed, preference };
}

export async function connectedScope(ctx, location, allowedProviders) {
  const providers = rows(await ctx.provider.list({ location }));
  const allowed = allowedProviders === undefined ? undefined : new Set(allowedProviders);
  const connected = [];
  for (const provider of providers) {
    if (allowed && !allowed.has(provider.id)) continue;
    // active() returns connection metadata, including environment-backed
    // connections. resolve(), which would return secrets, is never called.
    const connection = await ctx.integration.connection.active(provider.integrationID ?? provider.id);
    if (connection) connected.push(provider.id);
  }
  return connected;
}

export async function registerAutomaticRouter(ctx, bridge, options = {}, strategies) {
  const enabled = options.enabled !== false;
  const { allowedProviders, preference } = enabled ? validateOptions(options) : {};
  const registrations = [];
  const reservations = new Map();
  const lifetime = new AbortController();
  let eventError;

  async function scopeFor(session) {
    return connectedScope(ctx, session.location, allowedProviders);
  }

  async function catalogFor(session, inputs, textBudget, task = '') {
    const scope = await scopeFor(session);
    const available = rows(await ctx.model.list({ location: session.location }));
    const models = available.filter((m) => m.limit?.input === undefined || m.limit.input >= textBudget);
    const config = readRoutingConfig('opencode');
    return applyModelScope(buildCatalog(models, { allowedProviders: scope, requiredInputs: inputs,
      minContextTokens: textBudget + 4096 }), config, task);
  }

  const observe = (async () => {
    try {
      const types = ['session.deleted'];
      if (enabled) types.push('session.execution.succeeded', 'session.execution.failed',
        'session.execution.interrupted', 'session.inbox.cancelled');
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal, types })) {
        const sid = event.data?.sessionID;
        if (event.type === 'session.deleted' && typeof sid === 'string' && sid) {
          reservations.delete(sid);
          const identity = { host: 'opencode', sessionID: sid };
          try {
            await strategies.forget(identity);
          } catch {
            console.error('FM PCC Router could not remove a deleted chat’s strategy selection.');
          }
          try {
            await bridge.forget(identity);
          } catch {
            console.error('FM PCC Router could not remove a deleted chat’s local routing state.');
          }
          continue;
        }
        const reservation = reservations.get(sid);
        if (!reservation) continue;
        if (event.type === 'session.inbox.cancelled'
            && event.data?.inboxID !== reservation.messageID) continue;
        // Model-switch control work can complete during prompt admission.
        if (reservation.stage === 'selecting') continue;
        reservations.delete(sid);
      }
    } catch (error) {
      if (!lifetime.signal.aborted) eventError = error;
    }
  })();

  const stop = async () => {
    lifetime.abort();
    await Promise.allSettled(registrations.map((r) => r.dispose()));
    await observe;
    reservations.clear();
  };
  if (!enabled) return stop;

  try {
    registrations.push(await ctx.session.hook('prompt', async (event) => {
      if (eventError) throw new Error('The router event connection failed. Reload the plugin.');
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || isBusy(session)) return;
      if (reservations.has(event.sessionID)) throw new Error('A routed request is already pending in this chat.');
      const reservation = { messageID: event.messageID, stage: 'selecting' };
      reservations.set(event.sessionID, reservation);
      try {
        const messages = await ctx.session.context({ sessionID: event.sessionID });
        const files = [...(event.prompt.files ?? []), ...messages.flatMap((m) => m.files ?? [])];
        const inputs = requiredInputs(files);
        const text = event.prompt.text?.trim() ? event.prompt.text : 'Select a model for an attachment-only user request.';
        const textBudget = byteLength(text) + messages.reduce((total, m) => total + byteLength(textOf(m)), 0);
        const catalog = await catalogFor(session, inputs, textBudget, text);
        if (!catalog.length) throw new Error('No eligible models are available.');
        const identity = { host: 'opencode', sessionID: event.sessionID };
        const strategy = await strategies.current(identity);
        const nonce = randomUUID();
        const { body, catalog: fitted } = fitRoutingRequest({ text, context: routingContext(messages),
          currentModel: session.model, catalog, nonce, preference, strategy });
        if (reservations.get(event.sessionID) !== reservation) throw new Error('The chat was deleted during routing.');
        const route = parseRoutingResponse(await bridge.complete(body, { ...identity, messageID: event.messageID }), fitted, nonce);
        const currentCatalog = await catalogFor(session, inputs, textBudget, text);
        const offered = currentCatalog.some((m) => m.providerID === route.model.providerID && m.id === route.model.id
          && m.routes.some((v) => variantRef(v.variant) === variantRef(route.model.variant)));
        if (!offered) throw new Error('The selected model is no longer connected, allowed, or available.');
        const latest = await ctx.session.get({ sessionID: event.sessionID });
        if (reservations.get(event.sessionID) !== reservation) throw new Error('The chat was deleted during routing.');
        if (isBusy(latest)) throw new Error('The chat became busy before the routing decision could be applied.');
        await ctx.session.switchModel({ sessionID: event.sessionID, model: route.model });
        const applied = await ctx.session.get({ sessionID: event.sessionID });
        if (!sameRef(applied.model, route.model)) throw new Error('OpenCode did not apply the selected model and variant.');
        const record = { ...route, messageID: event.messageID };
        event.metadata = { ...event.metadata, foundationRouter: record };
        await ctx.session.update({ sessionID: event.sessionID,
          metadata: { ...applied.metadata, foundationRouter: record } });
        Object.assign(reservation, { stage: 'ready', model: route.model,
          title: text.replace(/\s+/g, ' ').slice(0, 80) });
      } catch (error) {
        if (reservations.get(event.sessionID) !== reservation) throw error;
        reservations.delete(event.sessionID);
        throw error;
      }
    }));

    registrations.push(await ctx.session.hook('model.request', async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      const scope = await scopeFor(session);
      if (!scope.includes(event.model.providerID)) throw new Error('Model inference outside the connected provider allowlist is blocked.');
      if (event.kind === 'primary' && !session.parentID) {
        const selected = reservations.get(event.sessionID)?.model ?? session.metadata?.foundationRouter?.model;
        if (!selected || !sameRef(event.model, selected)) throw new Error('The executor model does not match the validated PCC route.');
        const available = rows(await ctx.model.list({ location: session.location }));
        const enabled = available.some((m) => m.enabled === true && m.type === 'chat'
          && m.providerID === selected.providerID && m.id === selected.id
          && (!variantRef(selected.variant) || m.variants?.some((v) => v.id === selected.variant)));
        if (!enabled) throw new Error('The selected executor model or variant is no longer available.');
      }
    }));

    // Avoid an auxiliary title request selecting a different provider.
    registrations.push(await ctx.session.hook('title', (event) => {
      event.result = reservations.get(event.sessionID)?.title ?? 'Chat';
    }));
  } catch (error) {
    await stop();
    throw error;
  }

  return stop;
}
