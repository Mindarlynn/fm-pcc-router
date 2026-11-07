import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function parseTerminalSession(value) {
  const [id, tty, pid] = value.trim().split(/\r?\n/);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !/^\/dev\/tty[\w]+$/.test(tty ?? '')) {
    throw new Error('Could not determine the Terminal session identifier.');
  }
  const terminalPID = Number(pid);
  return { windowID: Number(id), tty,
    ...(/^[1-9]\d*$/.test(pid ?? '') && terminalPID > 1 && terminalPID <= 0x7fffffff ? { terminalPID } : {}) };
}

const LAUNCH = `use framework "AppKit"
use scripting additions

on run argv
    set launchCommand to item 1 of argv
    set windowLabel to item 2 of argv
    set sessionFile to item 3 of argv
    set ownTerminal to not (application "Terminal" is running)
    tell application "Terminal"
        set ownedTab to do script launchCommand
        set custom title of ownedTab to windowLabel
        set ownedTTY to tty of ownedTab
        repeat with ownedWindow in windows
            if tty of selected tab of ownedWindow is ownedTTY then
                set ownedID to id of ownedWindow
                set terminalPID to 0
                if ownTerminal then
                    set apps to current application's NSRunningApplication's runningApplicationsWithBundleIdentifier:"com.apple.Terminal"
                    if (apps's |count|() as integer) is 1 then set terminalPID to apps's firstObject()'s processIdentifier() as integer
                end if
                set sessionText to (ownedID as text) & linefeed & ownedTTY & linefeed & terminalPID
                set handle to open for access (POSIX file sessionFile) with write permission
                try
                    write sessionText to handle as «class utf8»
                on error errorText number errorNumber
                    close access handle
                    error errorText number errorNumber
                end try
                close access handle
                set visible of ownedWindow to false
                return sessionText
            end if
        end repeat
        error "Could not find the PCC managed window."
    end tell
end run
`;

const CLOSE = `use framework "AppKit"
use scripting additions

on run argv
    set windowLabel to item 1 of argv
    set ownedID to (item 2 of argv) as integer
    set ownedTTY to item 3 of argv
    set terminalPID to (item 4 of argv) as integer
    if not (application "Terminal" is running) then return
    tell application "Terminal"
        if not (exists window id ownedID) then return
        set ownedWindow to window id ownedID
        repeat 20 times
            if (count tabs of ownedWindow) is not 1 then return
            set ownedTab to selected tab of ownedWindow
            if tty of ownedTab is not ownedTTY or custom title of ownedTab is not windowLabel then return
            if not (busy of ownedTab) then
                close ownedWindow
                if terminalPID is 0 or (count windows) is not 0 then return
                set terminalProcess to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:terminalPID
                if terminalProcess is not missing value and (terminalProcess's bundleIdentifier() as text) is "com.apple.Terminal" then
                    terminalProcess's terminate()
                end if
                return
            end if
            delay 0.05
        end repeat
        error "The PCC managed window is busy."
    end tell
end run
`;

export function respondArguments(input, schema) {
  return ['respond', '--model', 'pcc', '--no-stream', '--resume', input, '--schema', schema,
    'Produce the requested JSON decision using the latest routing input in this transcript.'];
}

async function stopRespond(pidFile, input) {
  let pid;
  try {
    pid = Number((await readFile(pidFile, 'utf8')).trim());
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isInteger(pid) || pid < 2 || pid > 0x7fffffff) throw new Error('Invalid PCC process ID.');
  let command;
  try {
    command = (await exec('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000 })).stdout.trim();
  } catch (error) {
    if (error.code === 1) return;
    throw error;
  }
  if (!/^((\/usr\/bin\/)?fm) respond /.test(command) || !command.includes(`--resume ${input} `)) {
    throw new Error('The PCC process identity could not be verified.');
  }
  try { process.kill(pid, 'SIGTERM'); } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(50);
  }
  throw new Error('The PCC response process did not stop.');
}

export async function respondInTerminal(transcript, schema, signal, { timeoutMs = 45_000 } = {}) {
  if (process.platform !== 'darwin') throw new Error('This feature requires macOS 27 or later.');
  signal.throwIfAborted();
  const dir = await mkdtemp('/private/tmp/fm-pcc-');
  const input = join(dir, 'input.json');
  const schemaFile = join(dir, 'schema.json');
  const launch = join(dir, 'launch.applescript');
  const close = join(dir, 'close.applescript');
  const session = join(dir, 'session.txt');
  const pidFile = join(dir, 'respond.pid');
  const job = join(dir, 'respond.zsh');
  const runner = join(dir, 'run.zsh');
  const statusFile = join(dir, 'status');
  const output = join(dir, 'output.json');
  const label = `FM PCC Router ${randomUUID()}`;
  let identity;
  let launched = false;
  let completed = false;

  try {
    const args = respondArguments(input, schemaFile).map(shellQuote).join(' ');
    const write = (path, contents) => writeFile(path, contents, { mode: 0o600, flag: 'wx' });
    await Promise.all([
      write(input, JSON.stringify(transcript)),
      write(schemaFile, JSON.stringify(schema)),
      write(launch, LAUNCH), write(close, CLOSE), write(session, ''),
      write(job, `printf '%s\\n' "$$" > ${shellQuote(pidFile)}\nexec /usr/bin/fm ${args}\n`),
      write(runner, `umask 077\n/bin/zsh -f ${shellQuote(job)} > ${shellQuote(output)} 2>/dev/null\nprintf '%s\\n' "$?" > ${shellQuote(statusFile + '.tmp')}\n/bin/mv ${shellQuote(statusFile + '.tmp')} ${shellQuote(statusFile)}\n`),
    ]);
    signal.throwIfAborted();
    launched = true;
    // Let AppleScript finish recording the window before handling cancellation.
    const { stdout } = await exec('/usr/bin/osascript', [launch, `/bin/zsh -f ${shellQuote(runner)}`, label, session],
      { timeout: 15_000, maxBuffer: 8192 });
    identity = parseTerminalSession(stdout);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal.throwIfAborted();
      let status;
      try { status = (await readFile(statusFile, 'utf8')).trim(); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (status !== undefined) {
        completed = true;
        if (status !== '0') throw new Error('PCC respond failed in Terminal. Check Apple Intelligence availability and usage limits.');
        break;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for PCC respond.');
      await delay(80, undefined, { signal });
    }
    if ((await stat(output)).size > 65_536) throw new Error('The PCC response exceeded the output limit.');
    try { return JSON.parse(await readFile(output, 'utf8')); } catch {
      throw new Error('Invalid structured response from PCC.');
    }
  } finally {
    try {
      if (launched) {
        if (!completed) await stopRespond(pidFile, input);
        const recorded = identity ?? await readFile(session, 'utf8').then(value => value.trim() ? parseTerminalSession(value) : undefined);
        if (recorded) {
          await exec('/usr/bin/osascript', [close, label, String(recorded.windowID), recorded.tty,
            String(recorded.terminalPID ?? 0)], { timeout: 5000, maxBuffer: 8192 });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
