// ScriptRunner — the core port for running a TRUSTED local script (§ITEM 1). The
// pure `script` executor depends on this abstraction; the infra NodeScriptRunner
// implements it over child_process. The script identity is a NAME the adapter
// resolves against an allowlist — the port never carries a path or command, so
// core stays free of the FS/process I/O (DIP). `timeoutMs`/`cwd` omitted ⇒ the
// adapter's composition-time defaults (resolved from config at the manager root,
// exactly how maxConcurrentSteps is injected into the ConcurrencyGate).

export interface ScriptRunSpec {
  readonly script: string;        // allowlisted script id (resolved by the runner)
  readonly inputJson: string;     // JSON fed on stdin + EOS_NODE_INPUT
  readonly args: string[];        // resolved argv appended after the script
  readonly timeoutMs?: number;    // omitted ⇒ the runner's default
  readonly cwd?: string;          // omitted ⇒ the runner's default
}

export interface ScriptRunResult {
  readonly stdout: string;
  readonly exitCode: number;      // 0 ⇒ passed; nonzero (incl. timeout) ⇒ failed
  readonly stderr: string;
}

export interface ScriptRunner {
  run(spec: ScriptRunSpec): Promise<ScriptRunResult>;
}
