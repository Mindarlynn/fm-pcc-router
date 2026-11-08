import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

test('Terminal tries the verified window cleanup after a process identity check fails', {
  skip: process.platform !== 'darwin',
}, async t => {
  const primary = new Error('AppleScript launch failed after recording the session');
  const calls = [];
  let directory;
  let label;
  const originalExecFile = childProcess.execFile;
  const execFile = async (command, args) => {
    if (command === '/bin/ps') {
      calls.push('verify process');
      assert.deepEqual(args, ['-p', '123', '-o', 'command=']);
      return { stdout: '/usr/bin/unrelated' };
    } else if (basename(args[0]) === 'launch.applescript') {
      calls.push('launch');
      assert.equal(command, '/usr/bin/osascript');
      const session = args[3];
      directory = dirname(session);
      label = args[2];
      writeFileSync(session, '42\n/dev/ttys001\n987\n');
      writeFileSync(join(directory, 'respond.pid'), '123\n');
      throw primary;
    } else {
      calls.push('close window');
      assert.equal(command, '/usr/bin/osascript');
      assert.deepEqual(args, [join(directory, 'close.applescript'), label, '42', '/dev/ttys001', '987']);
      return { stdout: '' };
    }
  };
  execFile[promisify.custom] = execFile;
  childProcess.execFile = execFile;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  });

  const { respondInTerminal } = await import('../src/terminal.mjs');
  await assert.rejects(respondInTerminal([], {}, new AbortController().signal), error => error === primary);
  assert.deepEqual(calls, ['launch', 'verify process', 'close window']);
  assert.equal(existsSync(directory), false);
});
