import { PCCBridge } from '../src/bridge.mjs';

const bridge = new PCCBridge();
try {
  const first = await bridge.probe();
  const second = await bridge.probe();
  console.log(JSON.stringify({ status: 'passed', first, second }, null, 2));
} finally {
  await bridge.dispose();
}
