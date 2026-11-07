# FM PCC Router

[한국어](README.ko.md)

Uses Apple Foundation Models and Private Cloud Compute (PCC) to route OpenCode requests and select the model and reasoning effort of a Codex subagent.

## How it uses `fm serve`

The router starts `fm serve` in a hidden Terminal window on the Mac. The bridge sends routing requests to Apple PCC. The selected provider runs the task's model inference.

### OpenCode

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-opencode-dark.png">
  <img alt="OpenCode routing across local macOS, Apple PCC, and the selected provider" src="docs/architecture-opencode.png">
</picture>

OpenCode applies the route to the current session and reuses the server while the plugin is loaded.

### Codex

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-codex-dark.png">
  <img alt="Codex delegation through the local prompt hook and router, Apple PCC, and the selected model service" src="docs/architecture-codex.png">
</picture>

The Codex helper starts the server when the parent requests a subagent route and shuts it down after selection.

## Requirements

- macOS 27 or later with Apple Intelligence and PCC available.
- Node.js 20 or later and Git for installation from a release.
- OpenCode 2 desktop app and a connected provider for OpenCode routing.
- For Codex, a session with native subagents that accept model and reasoning effort overrides. The router can use the App Server bundled with the ChatGPT desktop app.

## Installation

```sh
npx skills add mindarlynn/fm-pcc-router
```

Ask `fm-pcc-router` to install from `https://github.com/mindarlynn/fm-pcc-router.git` and give it a release tag or full commit SHA. Choose **OpenCode only**, **Codex only**, or **both** when prompted. You can include your choice in the request.

The `skills add` command installs the setup skill. Running the skill installs the selected integrations. For a local checkout, run `npx skills add /path/to/fm-pcc-router` and give the skill that checkout path.

### After installation

- **OpenCode** — Restart OpenCode, open your usual project, and chat as usual. The plugin selects a model and applies it automatically.
- **Codex** — The installer adds FM PCC Router entries to your Codex user hooks. In **Settings > Hooks**, review and trust `UserPromptSubmit`. In a new chat, ask Codex to delegate a task. The hook gives Codex routing instructions. When Codex follows them, it sends the task description to PCC and applies the chosen model and effort when it creates the subagent. Explicit settings take precedence.

You can also use `$fm-pcc-router` to route one task explicitly. Trust the optional `PostModelRequest` hook to compare its selected model with the model observed in the subagent's requests.

The first PCC request may need macOS Terminal automation permission. The helper may also need local execution approval to start App Server and Terminal.app.

## Optional provider restriction

To limit selection to specific connected providers, add this entry to the `plugins` array in your global `~/.config/opencode/opencode.json` (or `opencode.jsonc`). Use their OpenCode provider IDs in `allowedProviders`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/fm-pcc-router/",
      "options": {
        "allowedProviders": ["openai"]
      }
    }
  ]
}
```

Only connected providers in this list are eligible. An empty list blocks all selection. Preserve unrelated settings and plugin entries when applying this example.

## Connection check

Run `/pcc-test` in an OpenCode chat to check PCC connectivity. This diagnostic does not start a task. If it fails, check Apple Intelligence availability, PCC usage limits, and Terminal automation permission.

## Privacy

For routing, OpenCode sends the current request and limited recent conversation text. Codex sends the delegation message or the task explicitly supplied to `fm-pcc-router`. Both send eligible model metadata to Apple PCC. The router does not read attachments, repository files, or Codex transcripts. Keep sensitive content out of delegation messages and use the automatic hook only where sending task text to Apple PCC is permitted.

## Removal

Ask **fm-pcc-router** to remove OpenCode, Codex, or both. Restart the affected apps. To remove the setup skill as well, run `npx skills remove fm-pcc-router` in the scope where you added it.

If you already removed the setup skill, the installed commands work with the default paths below. Substitute your configured base directories if you use `XDG_CONFIG_HOME` or `XDG_DATA_HOME`.

```sh
# OpenCode
/bin/zsh -f ~/.config/opencode/plugins/fm-pcc-router/integrations/opencode/manage.zsh uninstall

# Codex
node ~/.local/share/fm-pcc-router/codex/uninstall.mjs
```

For development and testing, see the [contribution guide](.github/CONTRIBUTING.md). See the [changelog](docs/CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
