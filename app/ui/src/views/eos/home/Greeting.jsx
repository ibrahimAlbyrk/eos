import { FIRST_RUN_LINE, handledLine, hello, needLine } from "./homeWords.js";

// The h1 (Main.dc.html): the hello, then in a dimmer voice what was handled
// and what needs the user. With no routine yet, the first-run line.
export function Greeting({ name, now, lastSeen, handled, needs, firstRun }) {
  const need = needLine(needs);
  return (
    <h1 className="eos-greeting">
      {hello(new Date(now).getHours(), name)}
      <br />
      {firstRun ? (
        <span className="eos-greeting__dim">{FIRST_RUN_LINE}</span>
      ) : (
        <>
          {handled != null && <span className="eos-greeting__dim">{handledLine(handled, now, lastSeen)}</span>}
          {need && <> <span className="eos-greeting__need">{need}</span></>}
        </>
      )}
    </h1>
  );
}
