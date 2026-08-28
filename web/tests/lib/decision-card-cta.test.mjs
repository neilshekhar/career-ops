import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/components/home/decision-card.tsx"),
  "utf8",
);

test("Today hands application work to the canonical queue", () => {
  assert.match(src, /href="http:\/\/127\.0\.0\.1:7777"/);
  assert.match(src, /> Open apply queue\s*</);
  assert.doesNotMatch(src, /setStatus\("Applied"\)/);
});
