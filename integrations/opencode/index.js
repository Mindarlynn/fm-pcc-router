import { createProbePlugin } from './plugin.mjs';

// Plugin.define is an identity helper in @opencode/plugin 2.2.6. Exporting
// the same { id, setup } contract keeps this integration dependency-free.
export default createProbePlugin();
