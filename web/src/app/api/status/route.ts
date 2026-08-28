import { execFileSync } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { canonicalizeStatus } from "@/lib/core/states";

// Tracker writeback delegates to the core locked writer. This web endpoint is
// deliberately not a submission service: canonical live applications become
// Applied only through the receipt-gated localhost dashboard after the
// candidate confirms submission. Historical/external imports use the explicit
// `set-status.mjs --external` CLI path so their provenance cannot be implicit.
export async function POST(req: Request) {
  let body: { n?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { n, status } = body;
  if (!n || typeof status !== "string" || !status.trim()) {
    return NextResponse.json({ error: "n and status required" }, { status: 400 });
  }
  // Rejected here rather than left to the CLI: these characters would break the
  // markdown row, and refusing them before spawning keeps the failure cheap and
  // the message specific.
  if (/[|\r\n*]/.test(status)) {
    return NextResponse.json({ error: "invalid status (table-breaking characters)" }, { status: 400 });
  }
  // Resolving aliases here lets the response echo the canonical label without
  // waiting on the CLI, and costs no process spawn for an unknown state.
  // set-status.mjs validates again against states.yml — this is a fast path,
  // not the authority.
  const canon = canonicalizeStatus(status);
  if (!canon) {
    return NextResponse.json({ error: `not a tracker-scoped canonical status: ${status}` }, { status: 400 });
  }
  if (canon === "Applied") {
    return NextResponse.json({
      error: "Applied is receipt-gated; use the localhost application dashboard after submission, or set-status.mjs --external for a historical/external application",
    }, { status: 409 });
  }

  try {
    const output = execFileSync(
      process.execPath,
      [path.join(careerOpsRoot(), "set-status.mjs"), String(n), canon, "--json"],
      {
        cwd: careerOpsRoot(),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(output) as { newStatus?: string; changed?: boolean };
    return NextResponse.json({ ok: true, status: result.newStatus ?? canon, changed: result.changed ?? false });
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    let detail = "tracker status update failed";
    try {
      const parsed = JSON.parse(String(err.stdout ?? "")) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      const stderr = String(err.stderr ?? "").trim();
      if (stderr) detail = stderr.replace(/^❌\s*/, "").split("\n")[0];
    }
    const http = err.status === 2 ? 404 : err.status === 3 ? 409 : err.status === 4 ? 503 : 409;
    return NextResponse.json({ error: detail }, { status: http });
  }
}
