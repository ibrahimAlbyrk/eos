// Loaded with `--import` by every package's test script, before any test file.
// A test run started inside an Eos session (an agent, a Code-view pane) inherits
// what the daemon exports into it: EOS_DAEMON_SOCK routes a fetch-mocked HTTP
// client to the live daemon, and the session's credentials and switches change
// what the code under test does. Tests set every variable they need themselves.
const SESSION_VAR = /^(EOS_|CLAUDE_CODE_|ANTHROPIC_)|^(DISABLE_AUTO_COMPACT|ENABLE_TOOL_SEARCH|CLAUDE_SECURESTORAGE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|ELECTRON_RUN_AS_NODE)$/;

for (const key of Object.keys(process.env)) {
  if (SESSION_VAR.test(key)) delete process.env[key];
}
