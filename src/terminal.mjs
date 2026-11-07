import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function parseTerminalSession(value) {
  const [id, tty, terminalPID, desktopPID] = value.trim().split(/\r?\n/);
  if (!/^\d+$/.test(id) || Number(id) < 1 || !/^\/dev\/tty[\w]+$/.test(tty ?? '')) {
    throw new Error('Could not determine the Terminal session identifier.');
  }
  const session = { windowID: Number(id), tty };
  for (const [key, pid] of Object.entries({ terminalPID, desktopPID })) {
    if (/^[1-9]\d*$/.test(pid ?? '') && Number(pid) > 1 && Number(pid) <= 0x7fffffff) {
      session[key] = Number(pid);
    }
  }
  return session;
}

const LAUNCH = `use framework "AppKit"
use scripting additions

on appPID(bundleID)
    set runningApps to current application's NSRunningApplication's runningApplicationsWithBundleIdentifier:bundleID
    if (runningApps's |count|() as integer) is not 1 then return 0
    return runningApps's firstObject()'s processIdentifier() as integer
end appPID

on run argv
    set launchCommand to item 1 of argv
    set windowLabel to item 2 of argv
    set sessionFile to item 3 of argv
    set ownTerminal to false
    set desktopPID to 0
    if item 4 of argv is "yes" then
        set desktopPID to my appPID("ai.opencode.desktop")
        set ownTerminal to not (application "Terminal" is running)
    end if
    tell application "Terminal"
        set ownedTab to do script launchCommand
        set custom title of ownedTab to windowLabel
        set ownedTTY to tty of ownedTab
        repeat with ownedWindow in windows
            if tty of selected tab of ownedWindow is ownedTTY then
                set ownedID to id of ownedWindow
                set terminalPID to 0
                if ownTerminal then set terminalPID to my appPID("com.apple.Terminal")
                set sessionText to (ownedID as text) & linefeed & ownedTTY & linefeed & terminalPID & linefeed & desktopPID
                set sessionHandle to open for access (POSIX file sessionFile) with write permission
                try
                    set eof of sessionHandle to 0
                    write sessionText to sessionHandle as «class utf8»
                on error errorText number errorNumber
                    close access sessionHandle
                    error errorText number errorNumber
                end try
                close access sessionHandle
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
        if (count tabs of ownedWindow) is not 1 then return
        set ownedTab to selected tab of ownedWindow
        if tty of ownedTab is not ownedTTY then error "The PCC managed window TTY has changed."
        if custom title of ownedTab is not windowLabel then error "The PCC managed window title has changed."
        if busy of ownedTab then error "The PCC managed window is busy."
        close ownedWindow
        if terminalPID is 0 or (count windows) is not 0 then return
    end tell
    set terminalProcess to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:terminalPID
    if terminalProcess is missing value then return
    if (terminalProcess's bundleIdentifier() as text) is "com.apple.Terminal" then
        terminalProcess's terminate()
    end if
end run
`;

export async function launchTerminalServer(state, signal) {
  if (process.platform !== 'darwin') throw new Error('This feature requires macOS 27 or later.');
  const scriptPath = join(state.dir, 'serve.sh');
  const script = `#!/bin/zsh -f\numask 077\nprintf '%s\\n' "$$" > ${shellQuote(join(state.dir, 'server.pid'))}\nexec /usr/bin/fm serve --socket ${shellQuote(state.socket)} > /dev/null 2>&1\n`;
  await writeFile(scriptPath, script, { mode: 0o700, flag: 'wx' });
  const appleScript = join(state.dir, 'launch.applescript');
  const sessionFile = join(state.dir, 'session.txt');
  await writeFile(sessionFile, '', { mode: 0o600, flag: 'wx' });
  await writeFile(appleScript, LAUNCH, { mode: 0o600, flag: 'wx' });
  try {
    const { stdout } = await exec('/usr/bin/osascript', [appleScript,
      `/bin/zsh -f ${shellQuote(scriptPath)}`, state.label, sessionFile, state.quitOwnedTerminal ? 'yes' : 'no'],
    { signal, timeout: 30_000, maxBuffer: 16_384 });
    Object.assign(state, parseTerminalSession(stdout));
  } catch (cause) {
    throw new Error('Failed to start the Terminal PCC server. Check OpenCode’s Terminal automation permission.', { cause });
  }
}

export async function stopTerminalServer(state) {
  let pid;
  try {
    const value = (await readFile(join(state.dir, 'server.pid'), 'utf8')).trim();
    if (!/^\d+$/.test(value) || Number(value) < 2) throw new Error('Invalid server PID.');
    pid = Number(value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (pid) {
    let command;
    try {
      command = (await exec('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 })).stdout.trim();
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    if (command) {
      if (!command.includes(`fm serve --socket ${state.socket}`)) {
        throw new Error('The server PID owner could not be verified, so it was not stopped.');
      }
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 40; i++) {
        try { process.kill(pid, 0); } catch (error) {
          if (error.code === 'ESRCH') { pid = undefined; break; }
          throw error;
        }
        await delay(50);
      }
      if (pid) throw new Error('The PCC server did not stop, so the managed window was kept open.');
    }
  }
  const closeScript = join(state.dir, 'close.applescript');
  if (!state.windowID || !state.tty) {
    try {
      const session = await readFile(join(state.dir, 'session.txt'), 'utf8');
      if (session.trim()) Object.assign(state, parseTerminalSession(session));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!state.windowID || !state.tty) return;
  await writeFile(closeScript, CLOSE, { mode: 0o600 });
  await exec('/usr/bin/osascript', [closeScript, state.label, String(state.windowID), state.tty,
    String(state.quitOwnedTerminal ? state.terminalPID ?? 0 : 0)],
    { timeout: 5000, maxBuffer: 8192 });
}
