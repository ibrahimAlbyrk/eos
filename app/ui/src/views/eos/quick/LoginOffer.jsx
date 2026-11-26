import { useEffect, useState } from "react";

// Whether to offer: the app can start at login, it is off, and the user was
// never asked (either answer is their choice; Settings › Eos turns it on later).
export const offerShown = (item) => Boolean(item?.available && !item.offered && item.state === "off");

export function OfferCard({ onChoose }) {
  return (
    <div className="eos-quick__offer" role="group" aria-label="Start at login">
      <div className="eos-quick__offer-text">
        <span className="eos-quick__offer-title">Start Eos at login?</span>
        <span>It opens hidden, so this panel and your schedules work from the moment you log in.</span>
      </div>
      <button type="button" className="eos-btn" onClick={() => onChoose(false)}>Not now</button>
      <button type="button" className="eos-btn" onClick={() => onChoose(true)}>Start at login</button>
    </div>
  );
}

// The one-time offer to start Eos at login (07 §4.1), in the quick panel: a
// door is most use when Eos is already running.
export function LoginOffer({ doors }) {
  const [item, setItem] = useState(null);
  useEffect(() => { doors?.loginItem().then(setItem, () => {}); }, [doors]);
  if (!offerShown(item)) return null;
  const choose = async (on) => setItem(await doors.setLoginItem(on).catch(() => ({ ...item, offered: true })));
  return <OfferCard onChoose={(on) => void choose(on)} />;
}
