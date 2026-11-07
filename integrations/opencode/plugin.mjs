import { PCCBridge } from '../../src/bridge.mjs';
import { registerAutomaticRouter } from './automatic.mjs';

export function createProbePlugin(makeBridge = () => new PCCBridge()) {
  return {
    id: 'foundation-pcc-probe',
    async setup(ctx) {
      if (typeof ctx.command?.transform !== 'function' || typeof ctx.session?.synthetic !== 'function') {
        throw new Error('This plugin requires the OpenCode 2.2.6 API.');
      }
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
        registration = await ctx.command.transform((editor) => editor.add({
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
            await ctx.session.synthetic({ sessionID, text,
              description: text.replace(/\s+/g, ' ').trim(), delivery: 'queue', resume: false });
          },
        }));
        if (ctx.options?.enabled !== false) {
          stopRouter = await registerAutomaticRouter(ctx, bridge, ctx.options);
        }
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  };
}
