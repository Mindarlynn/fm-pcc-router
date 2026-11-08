import { PCCBridge } from '../../src/bridge.mjs';
import { RoutingStrategies } from '../../src/strategies.mjs';
import { registerAutomaticRouter } from './automatic.mjs';

const strategyUsage = 'Usage: /pcc-strategy list | current | use <name>';

async function runStrategyCommand(strategies, sessionID, argumentText) {
  const args = argumentText.trim().split(/\s+/);
  const identity = { host: 'opencode', sessionID };
  if (args.length === 1 && args[0] === 'list') {
    return `Available PCC strategies: ${(await strategies.list()).join(', ')}`;
  }
  if (args.length === 1 && args[0] === 'current') {
    return `Current PCC strategy: ${(await strategies.current(identity)).id}`;
  }
  if (args.length === 2 && args[0] === 'use') {
    await strategies.select(identity, args[1]);
    return `Selected PCC strategy: ${args[1]}`;
  }
  return strategyUsage;
}

export function createProbePlugin(makeBridge = () => new PCCBridge(),
  makeStrategies = () => new RoutingStrategies()) {
  return {
    id: 'foundation-pcc-probe',
    async setup(ctx) {
      if (typeof ctx.command?.transform !== 'function' || typeof ctx.session?.synthetic !== 'function') {
        throw new Error('This plugin requires the OpenCode 2.2.6 API.');
      }
      const strategies = makeStrategies();
      const bridge = makeBridge();
      let registration;
      let stopRouter;
      const cleanup = async () => {
        try {
          await stopRouter?.();
          await registration?.dispose();
        } finally {
          await bridge.dispose();
        }
      };
      try {
        const notify = (sessionID, text) => ctx.session.synthetic({ sessionID, text,
          description: text.replace(/\s+/g, ' ').trim(), delivery: 'queue', resume: false });
        registration = await ctx.command.transform((editor) => {
          editor.add({
            name: 'pcc-test',
            description: 'Apple PCC 연결을 확인합니다.',
            async execute({ sessionID }) {
              let text;
              try {
                const result = await bridge.probe();
                text = `PCC 연결 성공 · model=${result.model} · 응답 ${result.elapsedMs}ms`;
              } catch (error) {
                text = `PCC probe failed\n\n${error instanceof Error ? error.message : 'Unknown error'}`;
              }
              await notify(sessionID, text);
            },
          });
          editor.add({
            name: 'pcc-strategy',
            description: 'List, show, or select the PCC routing strategy for this chat.',
            async execute({ sessionID, prompt }) {
              let text;
              try {
                text = await runStrategyCommand(strategies, sessionID, prompt.text);
              } catch (error) {
                text = `PCC strategy command failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
              }
              await notify(sessionID, text);
            },
          });
        });
        stopRouter = await registerAutomaticRouter(ctx, bridge, ctx.options, strategies);
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  };
}
