# Security

The OpenCode plugin sends the current user request and limited recent conversation text to Apple PCC for model selection. The Codex prompt hook supplies local guidance. When Codex delegates through that guidance or the explicit skill, the routing helper sends only the task description and eligible model metadata. Text included in a delegation message can be transmitted as part of that message. Review the data boundary in [README.md](../README.md#privacy) before use.

Please report suspected vulnerabilities privately to the repository owner through the private contact channel available to you. Do not include secrets or personal session data in public reports. No public repository URL or security email is configured in this package.
