import { PCCBridge } from '../../src/bridge.mjs';
import { registerAutomaticRouter } from './automatic.mjs';

async function makeShutdownRpc() {
  const { Rpc } = await import('@opencode/plugin/rpc');
  const empty = { type: 'object', additionalProperties: false };
  return Rpc.define({
    id: 'fm-pcc-router-desktop',
    methods: { close: { input: empty, output: empty, errors: {} } },
    events: {},
  });
}

export function createProbePlugin(makeBridge = (onDesktopExit) => new PCCBridge({ quitOwnedTerminal: true, onDesktopExit }),
  defineShutdown = makeShutdownRpc) {
  const closeBridges = new Set();
  return {
    id: 'foundation-pcc-probe',
    async setup(ctx) {
      if (typeof ctx.command?.transform !== 'function' || typeof ctx.session?.synthetic !== 'function') {
        throw new Error('This test plugin requires the OpenCode 2.2.6 API.');
      }
      let bridge;
      let registration;
      let shutdownRegistration;
      let stopRouter;
      let stopping;
      const closeBridge = () => {
        if (stopping) return stopping;
        const previous = bridge;
        bridge = makeBridge(onDesktopExit);
        stopping = previous.dispose().finally(() => { stopping = undefined; });
        return stopping;
      };
      const onDesktopExit = () => {
        void closeBridge().catch(error => console.error('FM PCC Router desktop cleanup failed:', error));
      };
      bridge = makeBridge(onDesktopExit);
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
          stopRouter = await registerAutomaticRouter(ctx, { complete: (body) => bridge.complete(body) }, ctx.options);
        }
        if (typeof ctx.rpc?.register === 'function') {
          shutdownRegistration = await ctx.rpc.register(await defineShutdown(), {
            async close() {
              const results = await Promise.allSettled([...closeBridges].map(close => close()));
              const failures = results.filter(result => result.status === 'rejected');
              if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'PCC cleanup failed.');
              return {};
            },
          });
          closeBridges.add(closeBridge);
        }
      } catch (error) {
        await stopRouter?.();
        await registration?.dispose();
        await bridge.dispose();
        throw error;
      }
      return async () => {
        closeBridges.delete(closeBridge);
        try {
          await shutdownRegistration?.dispose();
          await stopRouter?.();
          await registration?.dispose();
        } finally {
          await Promise.all([stopping, bridge.dispose()]);
        }
      };
    },
  };
}
