const { Plugin } = require('@opencode/plugin/gui');
const { Rpc } = require('@opencode/plugin/rpc');

const empty = { type: 'object', additionalProperties: false };
const shutdown = Rpc.define({
  id: 'fm-pcc-router-desktop',
  methods: { close: { input: empty, output: empty, errors: {} } },
  events: {},
});

module.exports = Plugin.define({
  os: ['macos'],
  main(ctx) {
    ctx.onCleanup(async () => {
      try {
        await ctx.client.rpc(shutdown).close({});
      } catch (error) {
        ctx.log.write('debug', 'FM PCC Router desktop cleanup request failed.', { error: String(error) });
      }
    });
  },
});
