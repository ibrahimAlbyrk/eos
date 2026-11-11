# Eos in Rust

The Rust implementation of Eos: one application that holds the window shell, the core and the agent
engine. It is built beside the TypeScript backend and replaces it in one release.

## Layout

```
crates/    one crate per responsibility, in layers (see xtask/src/layers.rs)
xtask/     repo checks (`cargo xtask layers`)
scripts/   check.sh: everything CI runs
fixtures/  recorded responses the Rust code must reproduce (fixtures/private is never committed)
```

## Rules

- A crate depends only on lower layers; `cargo xtask layers` enforces it and every crate must be listed there.
- `unsafe` is denied workspace-wide.
- OS differences live only in the platform kit and the shell.
- The agent engine (`eos-agent-sdk`) is imported by one adapter crate only.

## Check

```bash
scripts/check.sh    # fmt, clippy -D warnings, tests, layers
```
