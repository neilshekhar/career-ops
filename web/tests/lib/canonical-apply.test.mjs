import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("legacy web apply endpoints are absent and the catch-all fails closed", () => {
  for (const operation of ["close", "drive", "fill", "prefill", "session"]) {
    assert.equal(existsSync(join(ROOT, "src", "app", "api", "apply", operation, "route.ts")), false);
  }
  const route = read("src/app/api/apply/[[...path]]/route.ts");
  assert.match(route, /status:\s*410/);
  assert.match(route, /canonical-apply-workflow-required/);
  assert.doesNotMatch(route, /request\.json\(|chromium|playwright|openSession|fillSession/);
});

test("web UI and assistant hand live applications to the canonical queue", () => {
  const shell = read("src/components/app-shell.tsx");
  const button = read("src/components/apply-button.tsx");
  const page = read("src/app/apply/page.tsx");
  const registry = read("src/app/actions/registry.ts");
  const assistant = read("src/app/api/assistant/route.ts");

  assert.doesNotMatch(shell, /ApplyProvider|useApply/);
  assert.match(button, /http:\/\/127\.0\.0\.1:7777/);
  assert.match(button, /target="_blank"/);
  assert.match(page, /canonical apply workflow/i);
  assert.match(page, /active career-ops agent/i);
  assert.doesNotMatch(registry, /setApplyField|startApply|Opening the application form/);
  assert.match(assistant, /NEVER opens, drives, or fills a job-application form/);
});

test("orphan direct-apply implementation files stay removed", () => {
  const removed = [
    "src/components/apply-view.tsx",
    "src/components/apply/apply-provider.tsx",
    "src/components/apply/apply-backdrop-mount.tsx",
    "src/lib/apply/session.ts",
    "src/lib/apply/drive.ts",
    "src/lib/apply/extract.ts",
  ];
  for (const path of removed) assert.equal(existsSync(join(ROOT, path)), false, `${path} must stay retired`);
});
