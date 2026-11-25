// Eos's harness inside an App's frame under test (05 Q7), run before the
// App's own code: it hears the App's errors and console.error, gives the
// builder's tests their eosTest steps over a record of the calls the host
// answered, and once the App has loaded checks that it draws something and
// fits its width, runs the tests and reports to the host. The App's code
// runs in this same frame and could hide an error from these checks: only
// the host's undeclared-call check runs outside it. Must never contain a
// closing script tag.
(() => {
"use strict";
const host = window.parent;
const errors = [], failed = [], calls = [];
const say = (m) => { try { host.postMessage(m, "*"); } catch (e) {} };
const text = (v) => { try { return String(v && v.message ? v.message : v); } catch (e) { return "an error"; } };
window.addEventListener("error", (e) => { errors.push(text(e.error || e.message)); });
window.addEventListener("unhandledrejection", (e) => { errors.push("unhandled rejection: " + text(e.reason)); });
console.error = (...parts) => { errors.push("console.error: " + parts.map(text).join(" ")); };
window.addEventListener("message", (e) => {
  const m = e.data;
  if (e.source === host && m && m.eosTest === "call") calls.push({ name: m.name, arguments: m.arguments });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const find = (selector) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error("no element matches " + selector);
  return el;
};
const eosTest = Object.freeze({
  async click(selector) { find(selector).click(); await settle(); },
  async type(selector, value) {
    const el = find(selector);
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  },
  text(selector) { return find(selector).textContent || ""; },
  calls() { return calls.map((c) => ({ name: c.name, arguments: c.arguments })); },
  expect(ok, why) { if (!ok) failed.push(String(why || "an expectation failed")); },
});
const drawn = () => {
  const body = document.body;
  if (!body || body.getBoundingClientRect().height <= 0) return false;
  return body.innerText.trim().length > 0 || !!body.querySelector("canvas,svg,img,input,button,select,textarea,video");
};
window.addEventListener("load", () => {
  say({ eosTest: "loaded" });
  setTimeout(async () => {
    const findings = [];
    const de = document.documentElement;
    if (!drawn()) findings.push({ check: "empty", detail: "draws nothing" });
    if (de.scrollWidth > de.clientWidth + 1) {
      findings.push({ check: "narrow", detail: "is " + de.scrollWidth + " pixels wide in " + de.clientWidth });
    }
    const tests = window.__eosTests;
    if (typeof tests === "function") {
      try { await tests(eosTest); } catch (e) { failed.push("its tests threw: " + text(e)); }
    }
    for (const why of failed) findings.push({ check: "test", detail: why });
    for (const error of errors) findings.push({ check: "error", detail: error });
    say({ eosTest: "report", findings });
  }, 100);
});
})();
