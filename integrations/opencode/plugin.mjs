import { PCCBridge } from '../../src/bridge.mjs';
import { RoutingStrategies } from '../../src/strategies.mjs';
import { registerAutomaticRouter } from './automatic.mjs';

export function createOpenCodePlugin(makeBridge = () => new PCCBridge(),
  makeStrategies = () => new RoutingStrategies()) {
  return {
    id: 'foundation-pcc-probe',
    async setup(ctx) {
      if (typeof ctx.event?.subscribe !== 'function'
          || (ctx.options?.enabled !== false && typeof ctx.session?.hook !== 'function')) {
        throw new Error('This plugin requires the OpenCode 2.2.6 API.');
      }
      const strategies = makeStrategies();
      const bridge = makeBridge();
      let stopRouter;
      const cleanup = async () => {
        try {
          await stopRouter?.();
        } finally {
          await bridge.dispose();
        }
      };
      try {
        stopRouter = await registerAutomaticRouter(ctx, bridge, ctx.options, strategies);
      } catch (error) {
        await cleanup();
        throw error;
      }
      return cleanup;
    },
  };
}
