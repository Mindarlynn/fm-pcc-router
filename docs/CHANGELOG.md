# Changelog

## 0.5.1

- Run `./install.sh` to install and `./uninstall.sh` to remove FM PCC Router. Both support `--target`.
- Move installer implementation into `installer/` and the runtime CLI into `src/`.

## 0.5.0

### Routing transport

- Run one-shot `fm respond` calls in a temporary Terminal window and close the window after each routing decision.
- Track bounded transcript state by host and chat. Restore OpenCode context from the current chat and keep only delegation descriptions for Codex.
- Validate the PCC decision before updating local state and reuse validated results for duplicate OpenCode prompt events.
- Define reusable routing strategies in a shared local config and select one per OpenCode chat or Codex thread. New chats retain the existing default routing policy.
- Manage strategies and check PCC connectivity through one local `fm-pcc-router` command. Management commands and their results stay outside both chats.
- Inspect local setup and storage with the read-only `fm-pcc-router doctor` command.
- Wait for in-flight routing on the same chat before reading its latest transcript.
- Limit model candidates per provider or by model allowlist, and fit large catalogs to the PCC request budget.

### Installation and removal

- Clone the repository and run `node install.mjs` to install OpenCode, Codex, or both. Use the same installer with `--uninstall` to remove them.
- Install the Codex skill and user hooks together. Preserve existing user hooks and remove only the router's entries during uninstall.
- Install one shared launcher for either host and remove it with the last integration.
- Add the launcher directory to zsh or Bash PATH when needed and remove the managed entry with the last integration.
- Select one or both integrations with a terminal checkbox menu. Uninstall exits immediately when neither integration is installed.
- Retry cleanup of owned launcher and PATH entries after an interrupted uninstall, and attempt Terminal window cleanup independently of process cleanup.

### Codex routing

- Apply the PCC-selected model and reasoning effort when creating a Codex subagent for an explicit `$fm-pcc-router` request.
- Use the `UserPromptSubmit` hook to guide automatic routing when Codex plans to delegate. Explicit model and reasoning settings take precedence.
- Offer an optional `PostModelRequest` hook to check whether the subagent used the selected model.

### Documentation and licensing

- Add separate OpenCode and Codex architecture diagrams that show the one-shot PCC call and local chat state.
- License FM PCC Router under MIT and include the license with the installed skill and both integrations.

## 0.4.0

- Introduce FM PCC Router as the distribution for OpenCode and Codex.
- Add the opt-in Codex model and reasoning recommendation skill.
- Add target selection to the installer and uninstaller. Preserve the OpenCode plugin ID and installation path.

## 0.3.0

- Add global installation and removal scripts for all OpenCode projects in the current user account.

## 0.2.1

- Fixed default variant selection.
- Added dynamic routing from the currently connected providers and their available models.
