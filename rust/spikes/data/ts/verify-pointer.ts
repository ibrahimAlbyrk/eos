// Reads `{ publicKey, payload, signature }` on stdin (update/src/bin/sign-pointer.rs)
// and checks it the way the installed app does: wrapper schema, signature, payload schema.
import { readFileSync } from "node:fs";

import { SignedUpdatePointerSchema, UpdatePointerSchema } from "../../../../contracts/src/update.ts";
import { Ed25519UpdateSignature } from "../../../../infra/src/update/ed25519.ts";

const input = JSON.parse(readFileSync(0, "utf8")) as { publicKey: string; payload: string; signature: string };
const signed = SignedUpdatePointerSchema.parse({ payload: input.payload, signature: input.signature });
const ok = new Ed25519UpdateSignature([input.publicKey]).verify(signed.payload, signed.signature);
const pointer = UpdatePointerSchema.parse(JSON.parse(signed.payload));
const tampered = new Ed25519UpdateSignature([input.publicKey]).verify(signed.payload + " ", signed.signature);
console.log(JSON.stringify({ verified: ok, tamperedVerified: tampered, version: pointer.version }));
if (!ok || tampered) process.exit(1);
