// The Goes-to slot (03's entries `{id, kind: me|fixed|item_place, channel,
// address?, bound?}`). The recipients are shown locked: only the user adds
// one, by hand, in Eos's own dialog; one the user added by hand (a fixed
// address) is the user's to remove.

const CHANNELS = { mail: "mail", github: "GitHub", notify: "a notification", inbox: "Needs you" };

const channelWord = (channel) => CHANNELS[channel] ?? channel;

export function recipientText(r) {
  if (r.kind === "me") return `You, by ${channelWord(r.channel)}`;
  if (r.kind === "fixed") return `${r.address}, by ${channelWord(r.channel)}`;
  if (r.kind === "item_place") return `Where the item came from, on ${channelWord(r.channel)}`;
  return "A place this version cannot read";
}

function freeId(list) {
  const taken = new Set(list.map((r) => r.id));
  let n = list.length + 1;
  while (taken.has(`to-${n}`)) n += 1;
  return `to-${n}`;
}

export function goesToParts(goesTo) {
  const list = goesTo ?? [];
  const parts = list.flatMap((r, n) => [
    { key: `to.${r.id}`, label: "Recipient", locked: true, text: recipientText(r) },
    ...(r.kind === "fixed" ? [{ key: `to.${r.id}.remove`, label: `Remove ${r.address}`, editor: "act", text: "×", apply: () => list.filter((_, i) => i !== n) }] : []),
    { break: true },
  ]);
  if (list.length === 0) parts.push("Stays in Eos", { break: true });
  parts.push({ key: "to.add", label: "Add a recipient", editor: "recipient", text: "Add a recipient", optional: true, value: { channel: "mail", address: "" }, apply: ({ channel, address }) => [...list, { id: freeId(list), kind: "fixed", channel, address }] });
  return parts;
}
