import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePortPressure } from "../../port-pressure.ts";

const HEADER = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)";

function tw(localPort: number, dest: string): string {
  return `tcp4       0      0  127.0.0.1.${localPort}      ${dest}    TIME_WAIT  `;
}

describe("parsePortPressure", () => {
  it("counts only TIME_WAIT sockets holding a port inside the ephemeral range", () => {
    const out = [
      HEADER,
      tw(49200, "127.0.0.1.7400"),
      tw(65535, "127.0.0.1.7400"),
      // Below the range — a listener's own port, not an ephemeral allocation.
      tw(7400, "127.0.0.1.51000"),
      "tcp4       0      0  127.0.0.1.49300      127.0.0.1.7400    ESTABLISHED",
      "tcp4       0      0  *.7400                 *.*                    LISTEN",
    ].join("\n");
    const p = parsePortPressure(out, 49152, 65535);
    assert.equal(p.timeWait, 2);
    assert.equal(p.capacity, 16384);
    assert.equal(p.pct, 0);
  });

  it("ranks destinations so the report names what is burning the ports", () => {
    const out = [
      HEADER,
      tw(49200, "127.0.0.1.7400"),
      tw(49201, "127.0.0.1.7400"),
      tw(49202, "127.0.0.1.7400"),
      tw(49203, "160.79.104.10.443"),
      tw(49204, "149.154.166.110.443"),
      tw(49205, "149.154.166.110.443"),
    ].join("\n");
    const p = parsePortPressure(out, 49152, 65535);
    assert.deepEqual(p.topDestinations, [
      { dest: "127.0.0.1:7400", count: 3 },
      { dest: "149.154.166.110:443", count: 2 },
      { dest: "160.79.104.10:443", count: 1 },
    ]);
  });

  it("reports the percentage of a saturated range", () => {
    const lines = [HEADER];
    for (let port = 49152; port <= 49161; port++) lines.push(tw(port, "127.0.0.1.7400"));
    const p = parsePortPressure(lines.join("\n"), 49152, 49161);
    assert.equal(p.capacity, 10);
    assert.equal(p.timeWait, 10);
    assert.equal(p.pct, 100);
  });

  it("returns zeroes for empty output", () => {
    const p = parsePortPressure("", 49152, 65535);
    assert.equal(p.timeWait, 0);
    assert.equal(p.pct, 0);
    assert.deepEqual(p.topDestinations, []);
  });
});
