import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { defaultSessionRoot, withSession } from './session.mjs';

const maxFileBytes = 32_768;
const maxInstructionBytes = 2_000;
const defaults = { id: 'default' };
const validID = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id);

function defaultConfig() {
  const root = process.env.XDG_CONFIG_HOME;
  return join(root && isAbsolute(root) ? root : join(homedir(), '.config'), 'fm-pcc-router', 'strategies.json');
}

export function strategyInstructions(strategy) {
  if (strategy === undefined || strategy?.id === 'default') return '';
  const { id, instructions } = strategy ?? {};
  if (!validID(id) || typeof instructions !== 'string' || !instructions.trim()
      || Buffer.byteLength(instructions) > maxInstructionBytes) throw new Error('Invalid custom routing strategy.');
  return `\nUser-configured ranking preference (${id}):\n${instructions}\nEnd of ranking preference. Use it over the default ranking guidance when ordering offered routes. Keep the eligibility rules, response schema, and explicit model or reasoning choices in force.`;
}

export class RoutingStrategies {
  constructor({ file = defaultConfig(), selectionRoot = join(dirname(defaultSessionRoot()), 'strategy-selections') } = {}) {
    this.file = file;
    this.selectionRoot = selectionRoot;
  }

  async load() {
    const strategies = new Map([[defaults.id, defaults]]);
    const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code !== 'ENOENT') throw new Error('Could not open the routing strategy file.', { cause: error });
    });
    if (!file) return strategies;
    let contents;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > maxFileBytes) {
        throw new Error('The routing strategy file must be user-owned, protected from writes by others, and at most 32 KB.');
      }
      const bytes = Buffer.alloc(maxFileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxFileBytes) throw new Error('The routing strategy file exceeds 32 KB.');
      contents = bytes.toString('utf8', 0, length);
    } finally {
      await file.close();
    }
    let config;
    try { config = JSON.parse(contents); } catch { throw new Error('The routing strategy file contains invalid JSON.'); }
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.hasOwn(config, defaults.id)) {
      throw new Error('The routing strategy file must map custom names to instructions and reserve the name default.');
    }
    for (const [id, instructions] of Object.entries(config)) {
      const strategy = { id, instructions };
      strategyInstructions(strategy);
      strategies.set(id, strategy);
    }
    return strategies;
  }

  async list() {
    return [...(await this.load()).keys()];
  }

  async current(identity) {
    if (!identity) return defaults;
    const id = await this.access(identity, (record) => record?.strategy);
    if (id === undefined) return defaults;
    const strategy = (await this.load()).get(id);
    if (!strategy) throw new Error(`The selected routing strategy is missing: ${id}. Select another strategy or reset to default.`);
    return strategy;
  }

  async select(identity, id) {
    if (!validID(id)) throw new Error('Invalid routing strategy name.');
    if (id === defaults.id) return this.forget(identity);
    if (!(await this.load()).has(id)) throw new Error(`Unknown routing strategy: ${id}.`);
    await this.access(identity, (_record, commit) => commit({ strategy: id }));
  }

  forget(identity) {
    return this.access(identity, (_record, commit) => commit());
  }

  access(identity, task) {
    return withSession(this.selectionRoot, identity, task, { maxAgeMs: Infinity });
  }
}
