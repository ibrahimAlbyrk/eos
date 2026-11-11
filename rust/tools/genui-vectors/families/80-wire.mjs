// The boundary shapes: whether the schema accepts an input (the Rust types must
// accept and reject the same ones).

const ID = "v_7Hq2abcdEFGH";
const ACTION = { viewId: ID, actionId: "book", label: "Masa ayırt", viewTitle: "Kadıköy'de bu akşam", item: "moda", state: { party: 2 } };
const DELTA = { workerId: "w1", callId: "c1", name: "mcp__orchestrator__present", phase: "append", text: "{" };
const JUNK = [undefined, null, true, 5, 1.5, "", "x", " ", [], ["a"], {}, { a: 1 }, ID, "x".repeat(64), "x".repeat(65), "x".repeat(200), "x".repeat(201), "😀".repeat(100), "😀".repeat(101)];

export default function ({ call }) {
  const accepts = (schema, input) => call("wire", "accepts", schema, input);
  for (const id of [ID, "v_7Hq2", "v_7Hq2abcdEFG!", "x_7Hq2abcdEFGH", "v_7Hq2abcdEFGHI", "V_7Hq2abcdEFGH", "v_000000000000", ` ${ID}`, `${ID}\n`, 5, null, ""]) accepts("ViewId", id);

  accepts("ViewAction", ACTION);
  accepts("UserMessageAction", { viewId: ID, label: "Masa ayırt", viewTitle: "t" });
  accepts("GenuiDelta", DELTA);
  accepts("GenuiChange", { viewId: ID, state: {} });
  for (const [schema, base] of [["ViewAction", ACTION], ["UserMessageAction", { viewId: ID, label: "L", viewTitle: "t" }], ["GenuiDelta", DELTA], ["GenuiChange", { viewId: ID, state: { a: 1 } }]]) {
    for (const key of [...Object.keys(base), "extra"]) {
      for (const v of JUNK) {
        const input = { ...base };
        if (v === undefined) delete input[key];
        else input[key] = v;
        accepts(schema, input);
      }
    }
    for (const input of [null, 5, "x", [], [base], {}]) accepts(schema, input);
  }
  for (const phase of ["start", "append", "stop", "Start", "end", ""]) accepts("GenuiDelta", { ...DELTA, phase });

  const kb = 1024;
  for (const state of [{}, { a: 1 }, { nested: { list: [1, "2", null] } }, { blob: "y".repeat(32 * kb - 11) }, { blob: "y".repeat(32 * kb - 10) }, { blob: "ü".repeat(16 * kb - 5) }, { blob: "ü".repeat(16 * kb - 4) }, { blob: "y".repeat(40 * kb) }, [], [{}], null, 5, "x"]) {
    accepts("ViewState", state);
    accepts("ViewAction", { ...ACTION, state });
  }
  for (const item of ["moda", 5, -1.5, { id: "moda", name: "Moda Kıyı" }, {}, [], ["moda"], true, null, "x".repeat(200), "x".repeat(201)]) accepts("ViewAction", { ...ACTION, item });
  for (const level of ["rich", "balanced", "text", "Rich", "", null, 5]) accepts("GenuiLevel", level);
  for (const kind of ["view", "app", "View", "", null]) accepts("ViewKind", kind);
}
