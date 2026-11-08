# Security

The OpenCode plugin sends the current user request and limited recent conversation text to Apple PCC for model selection. The Codex prompt hook supplies local guidance. When Codex delegates through that guidance or the explicit skill, the routing helper sends the current task description and limited previous delegation descriptions from the same chat, if available. Both integrations send eligible model metadata and the selected custom strategy's instructions when applicable. Review the [README data policy](../README.md#privacy) before use.

Please report suspected vulnerabilities privately to the repository owner through the private contact channel available to you. Do not include secrets or personal session data in public reports.
