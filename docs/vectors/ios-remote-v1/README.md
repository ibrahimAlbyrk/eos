# Golden interop fixture — ios-remote-v1

Reference crypto bytes for the Eos iOS remote-control protocol
([`docs/ios-remote-protocol.md`](../../ios-remote-protocol.md) §9.2).

**Ownership (PINNED).** The Eos daemon side (Node, `sodium-native` ≥ 5 + built-in
`crypto`) is the canonical generator. The relay (Node) and iOS (Swift) clients
MUST reproduce every value here **byte-for-byte** with their own libsodium +
P-256 implementations before they wire crypto. An implementation that cannot
reproduce these bytes is not interoperable and MUST NOT ship.

## The go/no-go gate

`vectors.json → dataFrameKa.ciphertextTag` is the single go/no-go interop check:
the AEAD seal of the inner frame `{"t":"ka","ts":0}` under the derived
device→Mac traffic key, epoch 0 / dir c2s / seq 0. Reproduce it from the
committed inputs and you interoperate; differ by one byte and you do not.

`dataFrameKa` commits the exact `npub` (24 B) and `aad` (50 B) byte strings, not
just the final tag, so a mismatch is localized to inputs vs. the cipher.

> Note: the ka plaintext is the literal 17 UTF-8 bytes `{"t":"ka","ts":0}`
> (`plaintextHex` / `plaintextLen` in the fixture are authoritative). The spec
> §9.2 prose annotation "15 bytes" is a miscount — defer to these committed bytes.

## Files

- `inputs.json` — the randomized-but-pinned material: the two P-256 identity
  test keypairs (PKCS8 PEM) and the two pinned ECDSA signatures (`sigS`/`sigC`,
  ieee-p1363 `r‖s` hex). **These are FIXTURE TEST KEYS, never Secure-Enclave
  keys.** Regenerating them shifts every dependent ciphertext, so they are
  generated once and never rotated.
- `vectors.json` — all fixed inputs (echoed under `inputs`) plus the derived
  golden outputs: `crypto_kx` directional keys, transcript hashes TH2/TH3,
  handshake/traffic keys, `otsProof`, the sealed `encS`/`encC`, the
  `dataFrameKa` gate, a resume-path vector, and a step-up `bodyHash`.

## Reproduce / regenerate

```
cd manager
npx tsx --test remote/__tests__/fixture.test.ts   # re-derives from crypto.ts, asserts byte-equality (CI gate)
npx tsx remote/gen-fixture.ts                      # regenerate vectors.json from the pinned inputs (deterministic)
```

The fixture test runs as part of `cd manager && npm test`.

## Fixed inputs (spec §9.2)

| Input | Value |
|---|---|
| device ephemeral X25519 | RFC 7748 §6.1 "a" pair |
| Mac ephemeral X25519 | RFC 7748 §6.1 "b" pair |
| clientNonce(16) | `00112233445566778899aabbccddeeff` |
| serverNonce(16) | `ffeeddccbbaa99887766554433221100` |
| ots(32) | `01` × 32 |
| room (b64u22) | `AAAAAAAAAAAAAAAAAAAAAA` (16 zero bytes; roomLen 22) |
| clientId(16) | `000102030405060708090a0b0c0d0e0f` |
| resume ticketId(16) / psk(32) | `03`×16 / `02`×32 (fixture-defined) |
