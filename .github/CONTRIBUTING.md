# Contributing

Run `npm test` with Node.js 20 or later before submitting changes. Unit tests do not need credentials, Apple PCC, or a live OpenCode instance. The live smoke test (`npm run smoke`) is opt-in; use it only when you intend to contact Apple PCC and accept its usage limits. Never commit credentials, local session data, or personal configuration.

## Developer fixture

For manual plugin development, open [the OpenCode fixture](../test/fixtures/opencode/) in OpenCode. Its configuration loads the repository package through a relative path that ends with a slash. For regular installation, see the [README](../README.md#installation).
