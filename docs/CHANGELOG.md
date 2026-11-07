# Changelog

## 0.5.0

### Routing transport

- Run one-shot `fm respond` calls in a temporary Terminal window and close the window after each routing decision.
- Track bounded transcript state by host and chat. Restore OpenCode context from the current chat and keep only delegation descriptions for Codex.
- Validate the PCC decision before updating local state and reuse validated results for duplicate OpenCode prompt events.

### Installation and removal

- Clone the repository and run `node install.mjs` to install OpenCode, Codex, or both. Use the same installer with `--uninstall` to remove them.
- Install the Codex skill and user hooks together. Preserve existing user hooks and remove only the router's entries during uninstall.

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
