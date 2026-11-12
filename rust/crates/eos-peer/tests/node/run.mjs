// Entry of the interop harness. Today's TypeScript imports `ws` and `zod` from
// wherever its own package was installed; this checkout has no such install,
// so both are resolved from the folder beside this file instead.
import { registerHooks } from "node:module";

const here = import.meta.url;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "ws" || specifier === "zod") return nextResolve(specifier, { ...context, parentURL: here });
    return nextResolve(specifier, context);
  },
});

await import("./harness.ts");
