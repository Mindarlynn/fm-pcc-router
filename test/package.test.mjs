import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('package identity, MIT license, and plugin compatibility', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.name, 'fm-pcc-router');
  assert.equal(pkg.version, '0.4.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.match(await read('LICENSE'), /^MIT License$/m);
  assert.equal(await read('integrations/codex/skills/fm-pcc-router/LICENSE'), await read('LICENSE'));
  const plugin = (await import(pathToFileURL(resolve(root, pkg.exports['.'])).href)).default;
  assert.equal(plugin.id, 'foundation-pcc-probe');
});

test('local workspace and documented JSON examples reference this package directory', async () => {
  const fixture = 'test/fixtures/opencode';
  const workspace = JSON.parse(await read(fixture + '/opencode.json'));
  assert(workspace.plugins.some((entry) => entry.endsWith('/') && resolve(root, fixture, entry) === root));
  for (const document of ['README.md', 'README.ko.md']) {
    const examples = [...(await read(document)).matchAll(/```json\s*([\s\S]*?)```/g)];
    assert(examples.length > 0, `${document} must include a usable configuration example`);
    for (const match of examples) {
      const config = JSON.parse(match[1]);
      assert(Array.isArray(config.plugins));
      const refs = config.plugins.flatMap((entry) => typeof entry === 'string' ? [entry]
        : entry && typeof entry.package === 'string' ? [entry.package] : []);
      assert(refs.some((reference) => reference.endsWith('fm-pcc-router/')));
      for (const entry of config.plugins) {
        if (entry && typeof entry === 'object' && entry.options?.allowedProviders !== undefined) {
          assert(Array.isArray(entry.options.allowedProviders));
        }
      }
    }
  }
  const pkg = JSON.parse(await read(resolve(root, 'package.json')));
  assert.equal(pkg.name, 'fm-pcc-router');
  await import(pathToFileURL(resolve(root, pkg.exports['.'])).href);
});

test('public docs and CI files exist; local artifacts are excluded', async () => {
  for (const path of ['README.md', 'README.ko.md', '.gitignore', '.gitattributes', '.github/CONTRIBUTING.md',
    '.github/SECURITY.md', 'docs/CHANGELOG.md', '.github/workflows/test.yml', 'test/fixtures/opencode/opencode.json',
    'install.mjs', 'integrations/codex/skills/fm-pcc-router/SKILL.md',
    'integrations/opencode/index.js', 'integrations/opencode/plugin.mjs', 'integrations/opencode/manage.zsh',
    'integrations/codex/manage.mjs', 'integrations/codex/routing.md',
    'integrations/codex/codex-route.mjs', 'integrations/codex/codex-audit.mjs']) await read(path);
  const files = await readdir(root);
  assert(!files.includes('VALIDATION.json'));
  assert(!files.includes('install.sh'));
  assert(!files.includes('uninstall.sh'));
  assert(!files.includes('skills'));
  assert.match(await read('.gitignore'), /^\.DS_Store$/m);
});
