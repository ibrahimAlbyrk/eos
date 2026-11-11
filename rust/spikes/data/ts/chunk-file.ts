// The TypeScript side of chunk-file: same output for the same file.
import { readFileSync } from "node:fs";

import { chunkLengths } from "../../../../core/src/domain/update/chunker.ts";
import { sha256 } from "./gen.ts";

const data = readFileSync(process.argv[2]);
const lengths = chunkLengths(data);
let at = 0;
const ids = lengths.map((len) => sha256(data.subarray(at, (at += len))));
console.log(JSON.stringify({ sha256: sha256(data), lengths, ids }));
