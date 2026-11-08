import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

const marker = '# >>> FM PCC Router PATH >>>';
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const recordFile = directory => join(directory, '.fm-pcc-router-shell-path');

export function hasShellPathRecord(directory) {
  return Boolean(lstatSync(recordFile(directory), { throwIfNoEntry: false }));
}

function startupFile() {
  const shell = basename(process.env.SHELL ?? '');
  const home = homedir();
  if (shell === 'zsh') return join(process.env.ZDOTDIR || home, '.zshrc');
  if (shell === 'bash') {
    // On macOS, a new Bash terminal starts as a login shell and reads the first of these files.
    const candidates = ['.bash_profile', '.bash_login', '.profile'].map(name => join(home, name));
    return candidates.find(path => lstatSync(path, { throwIfNoEntry: false })) ?? candidates[0];
  }
}

function pathBlock(directory) {
  const literal = quote(directory);
  return Buffer.from(`\n${marker}\ncase ":\${PATH-}:" in\n  *:${literal}:*) ;;\n  *) export PATH="\${PATH:+$PATH:}"${literal} ;;\nesac\n# <<< FM PCC Router PATH <<<\n`);
}

function readOwned(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { contents: Buffer.alloc(0), mode: 0o600 };
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022)) {
    throw new Error(`Refusing to edit unsafe file '${path}'.`);
  }
  return { contents: readFileSync(path), mode: info.mode & 0o777 };
}

function replaceFile(path, contents, mode, before) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const stage = mkdtempSync(join(directory, '.fm-pcc-router-'));
  try {
    const temporary = join(stage, 'update');
    writeFileSync(temporary, contents, { mode });
    chmodSync(temporary, mode);
    if (!readOwned(path).contents.equals(before)) throw new Error(`The file '${path}' changed. Retry setup.`);
    renameSync(temporary, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function updateShellPath(directory, uninstall = false) {
  const record = recordFile(directory);
  const recordContents = readOwned(record).contents;
  const saved = recordContents.toString();
  if (uninstall && !saved) return;
  if (!uninstall && (process.env.PATH ?? '').split(':').includes(directory)) return;
  const rc = saved || startupFile();
  if (!rc || !isAbsolute(rc) || /[:\r\n]/.test(directory)
      || !['.zshrc', '.bash_profile', '.bash_login', '.profile'].includes(basename(rc))) {
    throw new Error('Could not identify a supported shell startup file.');
  }

  const { contents, mode } = readOwned(rc);
  const block = pathBlock(directory);
  const offset = contents.indexOf(block);
  if (uninstall) {
    if (offset >= 0) replaceFile(rc, Buffer.concat([contents.subarray(0, offset), contents.subarray(offset + block.length)]), mode, contents);
    else if (contents.includes(marker)) throw new Error(`The PATH block in '${rc}' was edited.`);
    rmSync(record, { force: true });
    return;
  }
  if (offset < 0 && contents.includes(marker)) throw new Error(`The PATH block in '${rc}' was edited.`);
  if (!saved) replaceFile(record, rc, 0o600, recordContents);
  if (offset < 0) replaceFile(rc, Buffer.concat([contents, block]), mode, contents);
  return rc;
}
