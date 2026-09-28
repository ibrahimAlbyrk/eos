// The Accounts rule in two lines: signed in → subscription, otherwise → API key.
// `detailed` adds a one-line explanation under each outcome (the welcome screen).

import { ArrowIcon } from "./icons.jsx";

export function RuleLegend({ detailed = false }) {
  return (
    <div className={"acc-rule" + (detailed ? " acc-rule--detailed" : "")}>
      <div className="acc-rule__row">
        <span className="acc-rule__when"><span className="acc-dot is-ok" />Signed in</span>
        <ArrowIcon size={detailed ? 15 : 11} />
        <span className="acc-rule__then">
          <b>{detailed ? "Subscription" : "Subscription, always"}</b>
          {detailed && <small>Covered by your plan — always, for every agent.</small>}
        </span>
      </div>
      <div className="acc-rule__row">
        <span className="acc-rule__when"><span className="acc-dot is-off" />Not signed in</span>
        <ArrowIcon size={detailed ? 15 : 11} />
        <span className="acc-rule__then">
          <b>API key</b>
          {detailed && <small>Metered by the provider, billed per token.</small>}
        </span>
      </div>
    </div>
  );
}
