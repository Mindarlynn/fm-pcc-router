# Route a Codex subagent with FM PCC Router

For an explicit `$fm-pcc-router` routing request, use the task supplied by the user. When following a prompt hook, apply this workflow only to a subagent you already intend and are allowed to create. Use its delegated task description and honor any explicit model or reasoning effort setting.

Confirm the current runtime exposes a native subagent tool that accepts explicit model and reasoning effort values. If it does not, report that this session cannot apply the PCC route.

Run `node` with the absolute path to `codex-route.mjs` beside this file and the argument `--audit`. Pass only the task description on standard input. Use a quoted here-document delimiter that does not appear in the task, or an equivalent literal input mechanism. Keep chat history, attachments, file contents, and credentials out of the input.

The helper needs local access to start Codex App Server and run the PCC client. Use the host's normal approval mechanism if the sandbox prevents local execution. When Codex supplies `CODEX_THREAD_ID`, the helper uses it locally to scope PCC routing state to that thread. Without a thread ID, the helper routes in one-shot mode.

Use the returned `model` and `effort` as explicit spawn settings. Map `effort` to `reasoning_effort` when the tool uses that field. Start one native subagent for the task with an unpinned role that honors both values. Give it the task and relevant constraints without forking the full chat.

Wait for the subagent and relay its result. If the route returned an `auditId`, run `node` with the absolute path to `codex-audit.mjs` beside this file and arguments `verify <auditId> <agentId>`. Use the agent ID returned by the spawn tool. Report the model check as matched, mismatched, or unverified, and report reasoning effort as the value supplied at spawn.

If routing fails, Codex rejects the settings, or the subagent fails, report the failure and stop the delegated task.
