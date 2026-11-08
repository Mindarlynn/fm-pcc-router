#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PCCBridge } from './src/bridge.mjs';
import { doctorReport } from './src/doctor.mjs';
import { RoutingStrategies } from './src/strategies.mjs';

const usage = `Usage:
  fm-pcc-router strategy list
  fm-pcc-router strategy current --chat <ref>
  fm-pcc-router strategy use <name> --chat <ref>
  fm-pcc-router test
  fm-pcc-router doctor
  fm-pcc-router --help

Chat references: codex://threads/<UUID> or opencode:<session ID>.`;

function chatIdentity(ref) {
  if (ref && ref === ref.trim()) {
    const codex = /^codex:\/\/threads\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(ref);
    if (codex) return { host: 'codex', sessionID: codex[1].toLowerCase() };
    const opencode = /^opencode:(ses_[0-9a-f]{12}[0-9A-Za-z]{14})$/.exec(ref);
    if (opencode) return { host: 'opencode', sessionID: opencode[1] };
  }
  throw new Error('Invalid chat reference. Use codex://threads/<UUID> or opencode:<session ID>.');
}

export async function runCLI(args, { makeBridge = () => new PCCBridge() } = {}) {
  const [command, action, ...rest] = args;
  if (args.length === 1 && command === '--help') return usage;
  if (args.length === 1 && command === 'doctor') return doctorReport();
  if (args.length === 1 && command === 'test') {
    const bridge = makeBridge();
    try {
      const result = await bridge.probe();
      return `PCC connection succeeded (model=${result.model}, ${result.elapsedMs}ms).`;
    } finally {
      await bridge.dispose();
    }
  }

  if (command === 'strategy') {
    const strategies = new RoutingStrategies();
    if (action === 'list' && rest.length === 0) {
      return `Available PCC strategies: ${(await strategies.list()).join(', ')}`;
    }
    if (action === 'current' && rest.length === 2 && rest[0] === '--chat') {
      const strategy = await strategies.current(chatIdentity(rest[1]));
      return `Current PCC strategy: ${strategy.id}`;
    }
    if (action === 'use' && rest.length === 3 && rest[1] === '--chat') {
      await strategies.select(chatIdentity(rest[2]), rest[0]);
      return `Selected PCC strategy: ${rest[0]}`;
    }
  }
  throw new Error(usage);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await runCLI(process.argv.slice(2)));
  } catch (error) {
    console.error(`FM PCC Router: ${error.message}`);
    process.exitCode = 1;
  }
}
