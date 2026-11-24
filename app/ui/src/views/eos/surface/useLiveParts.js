import { useEffect, useState } from "react";
import { ROUTES } from "../../../api/routes.js";
import { watchEosTopics } from "../../../state/eos/live.js";
import { transport } from "../../../state/eos/transport.js";

// Draws each of an issue's Live `parts` through the core and hands its HTML to
// `onSwap(part, html)`, then again on each event of the topics its query
// names. Answers the way to stop. Resolves once every first drawing is done.
export function followLiveParts(surfaceId, issueId, parts, onSwap) {
  let alive = true;
  const stops = [];
  const draw = async (part) => {
    const r = await transport.get(ROUTES.surfaceIssuePart(surfaceId, issueId, part));
    if (!alive || !r?.ok || typeof r.body?.html !== "string") return [];
    onSwap(part, r.body.html);
    return Array.isArray(r.body.topics) ? r.body.topics : [];
  };
  const first = Promise.all(parts.map(async (part) => {
    const topics = await draw(part);
    if (alive && topics.length) stops.push(watchEosTopics(topics, () => void draw(part)));
  }));
  const stop = () => {
    alive = false;
    stops.forEach((one) => one());
  };
  return { stop, first };
}

// The Live parts of one issue's page: the page names them when it is ready.
// `swaps` maps a part to the HTML the core drew last.
export function useLiveParts(surfaceId, issueId) {
  const [parts, setParts] = useState([]);
  const [swaps, setSwaps] = useState({});

  useEffect(() => {
    setParts([]);
    setSwaps({});
  }, [surfaceId, issueId]);

  useEffect(() => {
    if (!parts.length) return undefined;
    const { stop } = followLiveParts(surfaceId, issueId, parts, (part, html) => {
      setSwaps((held) => ({ ...held, [part]: html }));
    });
    return stop;
  }, [surfaceId, issueId, parts]);

  return { swaps, onLive: setParts };
}
