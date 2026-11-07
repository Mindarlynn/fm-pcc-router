# Changelog

## Unreleased

### Installation and removal

- Use `npx skills add mindarlynn/fm-pcc-router` to add the shared skill. Use the skill to install or remove the OpenCode integration, the Codex integration, or both.
- Install the Codex integration as a skill with user hooks. Preserve existing user hooks and remove only the router's entries during uninstall.
- Use `npx skills remove fm-pcc-router` to remove the shared skill after uninstalling the integrations.

### Codex routing

- Apply the PCC-selected model and reasoning effort when creating a Codex subagent for an explicit `$fm-pcc-router` request.
- Use the `UserPromptSubmit` hook to guide automatic routing when Codex plans to delegate. Explicit model and reasoning settings take precedence.
- Offer an optional `PostModelRequest` hook to check whether the subagent used the selected model.

### Documentation and licensing

- Add separate OpenCode and Codex architecture diagrams that show how each integration uses `fm serve`.
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
