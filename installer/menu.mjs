import { clearScreenDown, emitKeypressEvents, moveCursor } from 'node:readline';

export async function chooseTargets(rows, action, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Specify --target opencode, codex, or both.');

  const enabled = rows.filter(row => !row.disabled);
  if (!enabled.length) return [];
  const selected = new Set();
  let cursor = 0;
  let linesDrawn = 0;
  let hint = '';
  const clear = () => {
    if (!linesDrawn) return;
    moveCursor(output, 0, -linesDrawn);
    clearScreenDown(output);
    linesDrawn = 0;
  };
  const draw = () => {
    clear();
    const options = rows.map(row => {
      const pointer = enabled[cursor] === row ? '>' : ' ';
      const check = selected.has(row.id) ? 'x' : ' ';
      const status = row.status ? ` (${row.status})` : '';
      return `  ${pointer} [${check}] ${row.label}${status}`;
    });
    const lines = [
      `FM PCC Router · ${action}`, '',
      ...options,
      '', `  ↑/↓ Move   Space Toggle   Enter ${action}   Esc Cancel`,
    ];
    if (hint) lines.push(`  ${hint}`);
    const width = Math.max(1, (output.columns || 80) - 1);
    output.write(lines.map(line => [...line].slice(0, width).join('')).join('\r\n') + '\r\n');
    linesDrawn = lines.length;
  };

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  let onKey, cancel, onError;
  try {
    input.setRawMode(true);
    return await new Promise((resolve, reject) => {
      cancel = () => resolve([]);
      onError = reject;
      onKey = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return cancel();
        if (key.name === 'return' || key.name === 'enter') {
          if (selected.size) return resolve(enabled.filter(row => selected.has(row.id)).map(row => row.id));
          hint = 'Select at least one app.';
        } else if (key.name === 'up' || key.name === 'down') {
          const step = key.name === 'up' ? -1 : 1;
          cursor = (cursor + step + enabled.length) % enabled.length;
        } else if (key.name === 'space') {
          const { id } = enabled[cursor];
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          hint = '';
        } else return;
        draw();
      };
      input.on('keypress', onKey);
      input.once('end', cancel);
      input.once('error', onError);
      process.once('SIGINT', cancel);
      draw();
      input.resume();
    });
  } finally {
    if (onKey) {
      input.off('keypress', onKey);
      input.off('end', cancel);
      input.off('error', onError);
      process.off('SIGINT', cancel);
    }
    input.pause();
    input.setRawMode(Boolean(wasRaw));
    clear();
  }
}
