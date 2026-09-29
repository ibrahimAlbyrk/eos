import { useEffect } from "react";
import { useHosts, ensureHostsLoaded, hostLabel, reconnectMachine, requestConnect } from "../../state/hostsStore.js";
import { currentHost, isRemoteView } from "../../lib/host.js";

// A controlled computer's window when its link is down: the content stays, a
// slim banner says what's happening. Agents over there keep running regardless.
export function LinkBanner() {
  const { hosts } = useHosts();
  useEffect(() => { ensureHostsLoaded(); }, []);
  if (!isRemoteView()) return null;
  const host = hosts.find((h) => h.id === currentHost()?.id);
  const link = host?.link;
  if (!host || !link || link.state === "live") return null;
  const name = <b>{hostLabel(host)}</b>;

  if (link.state === "unauthorized") {
    const changed = link.error === "identity-changed";
    return (
      <div className="link-banner" role="alert">
        <span className="host-chip__dot host-chip__dot--err" />
        <span>{changed ? <>{name}'s identity changed — Eos won't connect until you pair again.</> : <>{name} no longer accepts this Mac.</>}</span>
        <button type="button" className="m-btn m-btn--sm" onClick={requestConnect}>Pair again</button>
      </div>
    );
  }
  const off = link.error === "remote-access-off";
  return (
    <div className="link-banner" role="status">
      <span className="host-chip__dot host-chip__dot--warn" />
      <span>
        {off ? <>Remote access is off on {name}.</>
          : link.state === "connecting" ? <>Connecting to {name}…</>
          : <>Connection to {name} lost. Reconnecting — agents there keep running.</>}
      </span>
      {link.attempt > 1 && <span className="link-banner__attempt">attempt {link.attempt}</span>}
      <button type="button" className="m-btn m-btn--sm" onClick={() => reconnectMachine(host.id)}>Retry now</button>
    </div>
  );
}
