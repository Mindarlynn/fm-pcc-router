import { PCCBridge } from '../../src/bridge.mjs';
import { registerAutomaticRouter } from './automatic.mjs';

export function createProbePlugin(makeBridge = () => new PCCBridge()) {
  return {
    id: 'foundation-pcc-probe',
    async setup(ctx) {
      if (typeof ctx.command?.transform !== 'function' || typeof ctx.session?.synthetic !== 'function') {
        throw new Error('This test plugin requires the OpenCode 2.2.6 API.');
      }
      const bridge = makeBridge();
      let registration;
      let stopRouter;
      try {
        registration = await ctx.command.transform((editor) => editor.add({
          name: 'pcc-test',
          description: '숨긴 Terminal을 통해 Apple PCC 연결을 확인합니다.',
          async execute({ sessionID }) {
            let text;
            try {
              const result = await bridge.probe();
              text = `PCC 연결 성공 · model=${result.model} · 응답 ${result.elapsedMs}ms\n\n숨긴 Terminal의 fm serve에서 PCC 응답을 확인했습니다.`;
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
        await registration?.dispose();
        await bridge.dispose();
        throw error;
      }
      return async () => {
        try {
          await stopRouter?.();
          await registration?.dispose();
        } finally { await bridge.dispose(); }
      };
    },
  };
}
