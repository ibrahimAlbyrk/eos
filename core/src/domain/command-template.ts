// expandCommandTemplate — expands a prompt-template slash-command's `.md` body into
// the literal user text the model receives, for backends that do NOT expand
// templates natively (the in-process lane: capabilities.expandsSlashTemplates is
// false; the claude lanes expand inside the bundled binary). Pure domain — the
// caller (manager) reads the `.md` and supplies the file/shell seams; this function
// owns ONLY the substitution grammar.
//
// Grammar (matches the bundled binary's slash-command templating):
//   !`cmd`        run `cmd`, splice its stdout in           (via ctx.run)
//   @path         splice the file's contents in             (via ctx.readFile)
//   $ARGUMENTS    the full argument string
//   $1 … $N       positional arguments (whitespace-split)
//
// Order: `!`cmd`` and `@path` are resolved against the TEMPLATE first, then the
// arguments are substituted LAST — so an argument value can never inject a command
// execution or file read (the metered lane has no interactive trust prompt, so this
// ordering is the safety boundary).

export interface CommandTemplateContext {
  // Run a shell command for `!`cmd`` (the Bash built-in / ProcessRunner), cwd-scoped
  // by the caller. Returns the command's textual output.
  run(command: string): Promise<string>;
  // Read a file for `@path` includes, resolved by the caller relative to cwd.
  readFile(path: string): Promise<string>;
}

export async function expandCommandTemplate(
  md: string,
  args: string,
  ctx: CommandTemplateContext,
): Promise<string> {
  // 1. !`cmd` — run each and splice stdout (a failed command leaves a visible note,
  //    never an exception that sinks the turn).
  let out = await replaceAsync(md, /!`([^`]+)`/g, async (_full, cmd: string) => {
    try {
      return (await ctx.run(cmd)).replace(/\s+$/, "");
    } catch (e) {
      return `[command failed: ${e instanceof Error ? e.message : String(e)}]`;
    }
  });
  // 2. @path — splice file contents (an unresolved include is left verbatim).
  out = await replaceAsync(out, /(^|\s)@(\S+)/g, async (_full, lead: string, path: string) => {
    try {
      return `${lead}${(await ctx.readFile(path)).replace(/\s+$/, "")}`;
    } catch {
      return `${lead}@${path}`;
    }
  });
  // 3. arguments — $ARGUMENTS (whole string) then $1…$N (positional).
  const positional = args.trim().length ? args.trim().split(/\s+/) : [];
  out = out.replace(/\$ARGUMENTS\b/g, args);
  out = out.replace(/\$(\d+)/g, (_full, n: string) => positional[Number(n) - 1] ?? "");
  return out;
}

// String.replace with an async replacer — applies fn to each match in document
// order, splicing the resolved values back in. Guards against a zero-width match
// looping forever.
async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (...m: string[]) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(input)) !== null) {
    parts.push(input.slice(last, m.index));
    parts.push(await fn(...m));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  parts.push(input.slice(last));
  return parts.join("");
}
