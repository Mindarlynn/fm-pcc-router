import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const maxBytes = 32_768;
const hosts = ['opencode', 'codex'];
const validID = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const modelKey = ({ providerID, id }) => JSON.stringify([providerID, id]);

export function readRoutingConfig(host, env = process.env) {
  if (!hosts.includes(host)) throw new Error('Invalid routing host.');
  const root = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  const path = join(root, 'fm-pcc-router', 'routing.json');
  let file;
  try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Could not open the routing candidate configuration.', { cause: error });
  }

  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > maxBytes) {
      throw new Error('The routing candidate file must be user-owned, protected from writes by others, and at most 32 KB.');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(file, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > maxBytes) throw new Error('The routing candidate file exceeds 32 KB.');
    let config;
    try { config = JSON.parse(bytes.toString('utf8', 0, length)); }
    catch { throw new Error('The routing candidate file contains invalid JSON.'); }
    if (!object(config) || Object.keys(config).some(key => key !== 'hosts') || !object(config.hosts)
        || Object.keys(config.hosts).some(key => !hosts.includes(key))) {
      throw new Error('The routing candidate file must contain a hosts object for OpenCode or Codex.');
    }
    for (const section of Object.values(config.hosts)) {
      if (!object(section) || Object.keys(section).some(key => !['models', 'maxModelsPerProvider'].includes(key))
          || (Object.hasOwn(section, 'models') && (!Array.isArray(section.models) || !section.models.every(model =>
            object(model) && Object.keys(model).length === 2 && validID(model.providerID) && validID(model.id))))
          || (Object.hasOwn(section, 'maxModelsPerProvider') && (!Number.isSafeInteger(section.maxModelsPerProvider)
            || section.maxModelsPerProvider < 1))) {
        throw new Error('Invalid routing candidate settings. Use model references and a positive maxModelsPerProvider.');
      }
    }
    return config.hosts[host] ?? {};
  } finally {
    closeSync(file);
  }
}

export function namedModels(catalog, task) {
  const counts = new Map();
  for (const { id } of catalog) counts.set(id, (counts.get(id) ?? 0) + 1);
  const mentions = id => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w./:-])${escaped}(?=$|[^\\w./:-]|\\.(?:\\s|$))`).test(task);
  };
  return new Set(catalog.filter(({ providerID, id }) => mentions(`${providerID}/${id}`)
    || (counts.get(id) === 1 && mentions(id))));
}

export function applyModelScope(catalog, config = {}, task = '') {
  const allow = config.models && new Set(config.models.map(modelKey));
  const scoped = allow ? catalog.filter(model => allow.has(modelKey(model))) : catalog;
  const cap = config.maxModelsPerProvider;
  if (cap === undefined) return scoped;
  const explicit = namedModels(scoped, task);
  const counts = new Map();
  const kept = new Set();
  for (const model of [...explicit, ...scoped.filter(model => !explicit.has(model))]) {
    const count = counts.get(model.providerID) ?? 0;
    if (count >= cap) {
      if (explicit.has(model)) throw new Error('Named models exceed maxModelsPerProvider. Increase the limit or name fewer models.');
      continue;
    }
    counts.set(model.providerID, count + 1);
    kept.add(model);
  }
  return scoped.filter(model => kept.has(model));
}
