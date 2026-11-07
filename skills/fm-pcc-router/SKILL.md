---
name: fm-pcc-router
description: Install or remove FM PCC Router on macOS, or route an explicitly requested Codex subagent through Apple PCC.
compatibility: Requires macOS 27 with Apple Intelligence and PCC available, Node.js 20 or later, and Git when installing from a release.
---

## Install or remove

Use the user's chosen target, or ask them to choose OpenCode, Codex, or both. Pass the selection as `--target opencode`, `--target codex`, or `--target both`.

For installation, use the FM PCC Router source the user selected. For a release, pass its HTTPS repository URL and exact release tag or full commit SHA. For a local checkout, pass its path and omit `--ref`. Ask for the source or release if it is missing.

Run `node` with the absolute path to `scripts/install.mjs` in this skill directory. For example:

```sh
node "/path/to/fm-pcc-router/scripts/install.mjs" --source "<repository-https-url>" --ref "<release-tag-or-commit>" --target codex
```

Report the result for each target. For OpenCode, restart the app. For Codex, open **Settings → Hooks** and review and trust FM PCC Router's `UserPromptSubmit` hook. Review the optional `PostModelRequest` hook if model verification is wanted.

For removal, run the same helper with `--uninstall --target <target>` and omit `--source` and `--ref`. Report the result for each target and ask the user to restart the affected apps.

## Route a Codex subagent

When the user asks to route a delegated task, read `fm-pcc-router/codex/integrations/codex/routing.md` under `XDG_DATA_HOME` or the default `~/.local/share`. Follow that workflow with the task the user supplied. If the file is missing, ask the user to install the Codex integration first.
