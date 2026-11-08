# FM PCC Router

[한국어](README.ko.md)

Uses Apple Foundation Models and Private Cloud Compute (PCC) to route OpenCode requests and select the model and reasoning effort of a Codex subagent.

## How routing works

The router opens a temporary Terminal window and runs `fm respond --model pcc` once per routing decision. It supplies the routing input in a private transcript file and closes the window after the call. The selected provider runs the task's model inference.

Both integrations apply the [local candidate limits](#optional-model-candidate-limits) and the [strategy selected for the chat](#routing-strategies) before sending a routing request. The shared CLI changes strategy settings outside the conversation.

### OpenCode

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-opencode-dark.png">
  <img alt="OpenCode applies local candidate limits and a chat strategy, asks Apple PCC for a route, and switches to the selected provider and model" src="docs/architecture-opencode.png">
</picture>

OpenCode uses the current chat's recent history and keeps routing state keyed to that chat. A validated route is applied to the current session. Deleting a chat clears its local routing state.

### Codex

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-codex-dark.png">
  <img alt="The Codex helper serializes PCC routing within a thread and returns model and effort settings for subagents that can run in parallel" src="docs/architecture-codex.png">
</picture>

The Codex helper runs when the parent requests a subagent route. When a thread ID is available, routing calls for that thread wait for each other so the next call reads the latest saved delegation history. Once each call returns its model and effort, the parent can run the subagent tasks in parallel.

## Requirements

- macOS 27 or later with Apple Intelligence and PCC available.
- Node.js 20 or later and Git.
- OpenCode 2 desktop app and a connected provider for OpenCode routing.
- For Codex, a session with native subagents that accept model and reasoning effort overrides. The router can use the App Server bundled with the ChatGPT desktop app.

## Installation

```sh
git clone https://github.com/mindarlynn/fm-pcc-router.git
cd fm-pcc-router
./install.sh
```

Use the arrow keys to move, **Space** to select one or both apps, and **Enter** to install. **Esc** cancels. To skip the menu, pass `--target opencode`, `--target codex`, or `--target both`. To upgrade an existing installation, run `./uninstall.sh` for the affected hosts before installing the new version.

Either target installs `fm-pcc-router` in `~/.local/bin` (or `$XDG_BIN_HOME`). If that directory is missing from `PATH`, setup appends it in your zsh or Bash startup file. Open a new terminal tab to use the command. For other shells, setup prints the full command path.

### After installation

- **OpenCode** — Restart OpenCode, open your usual project, and chat as usual. The plugin selects a model and applies it automatically.
- **Codex** — The installer adds the `fm-pcc-router` skill and registers Codex user hooks. Quit the Codex app with **Cmd+Q** and reopen it to load the new hooks. Then review and trust `UserPromptSubmit` in **Settings > Hooks**. In a new chat, ask Codex to delegate a task. The hook gives Codex routing instructions. When Codex follows them, it sends the task description to PCC and applies the chosen model and effort when it creates the subagent. Explicit settings take precedence.

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

## Optional model candidate limits

By default, the router considers eligible models from every allowed provider. To limit the number of candidates per provider, create `~/.config/fm-pcc-router/routing.json` (under `$XDG_CONFIG_HOME` if set):

```json
{
  "hosts": {
    "opencode": { "maxModelsPerProvider": 12 },
    "codex": { "maxModelsPerProvider": 12 }
  }
}
```

For a model allowlist, add a `models` array to either host with entries such as `{"providerID":"openai","id":"your-model-id"}`. Use the provider ID `codex` for Codex models. Omitting `models` keeps every eligible model in scope. The OpenCode provider restrictions still apply. An invalid file stops routing until it is corrected. If the request exceeds the PCC input budget, the router first removes optional labels and then balances the shortlist across providers, preserving eligible models named in the task within the configured scope.

## Routing strategies

New chats use `default`, the built-in routing strategy. To define reusable strategies for either app, create `~/.config/fm-pcc-router/strategies.json` (under `$XDG_CONFIG_HOME` if set):

```json
{
  "fast": "Prefer low latency and low reasoning for routine tasks.",
  "review": "Favor accuracy and deeper reasoning for security reviews and complex debugging."
}
```

Run these commands in a terminal. Replace `<chat-ref>` with the target chat reference.

```sh
fm-pcc-router strategy list
fm-pcc-router strategy current --chat '<chat-ref>'
fm-pcc-router strategy use review --chat '<chat-ref>'
fm-pcc-router strategy use default --chat '<chat-ref>'
```

- **OpenCode** — Use `opencode:<session-id>`. Run `opencode session list` from the chat's project to find its ID.
- **Codex** — Use the `codex://threads/<id>` link copied from the chat with **Cmd+Option+L**. The selection applies to subagent routing.

Each chat keeps its own selection and transcript. The management commands run outside the chat. Editing a strategy takes effect on the next routing request. If you remove an active strategy, select another one or reset the chat to `default`.

Strategy names use lowercase letters, digits, and hyphens, start with a letter, and are at most 40 characters. Keep each strategy under 2,000 UTF-8 bytes and the file within 32 KB. PCC receives the selected strategy's instructions to rank eligible routes. Connected-provider restrictions, model eligibility, and explicit user choices still take precedence.

## Connection check

Run `fm-pcc-router test` in a terminal to check PCC connectivity. The diagnostic uses a fixed probe. If it fails, check Apple Intelligence availability, PCC usage limits, and Terminal automation permission.

Run `fm-pcc-router doctor` for a read-only check of installed integrations, Codex hook registration, local settings, and storage permissions. It prints status summaries without contacting PCC or showing conversation or strategy contents. Check hook trust in Codex Settings.

## Privacy

For routing, OpenCode sends the current request and limited recent conversation text. Codex sends the current delegation description and any bounded history of prior delegations from the same thread. Both send eligible model metadata and the selected custom strategy's instructions, when applicable, to Apple PCC. The router does not read attachments, repository files, or Codex transcripts. Keep sensitive content out of delegation messages and use the automatic hook only where sending task text to Apple PCC is permitted.

Routing records are stored locally under `$XDG_STATE_HOME/fm-pcc-router/sessions` (default `~/.local/state/fm-pcc-router/sessions`). The saved context is limited to eight entries and 6,000 UTF-8 bytes per chat. The router ignores records older than seven days. To clear all saved routing history, remove this directory while the router is idle.

## Removal

```sh
./uninstall.sh
```

The removal menu lists installed integrations. Select with **Space** and confirm with **Enter**. If neither integration is installed, setup reports that and exits. Codex removal also removes the installed skill and hook entries. The last integration removes the shared command and its managed PATH entry. Restart the affected apps.

For development and testing, see the [contribution guide](.github/CONTRIBUTING.md). See the [changelog](docs/CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
