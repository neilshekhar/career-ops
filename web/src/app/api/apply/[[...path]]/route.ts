export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE =
  "The legacy web direct-apply API is retired. Use the localhost apply queue and an active career-ops agent so modes/apply.md, modes/_custom.md, and queue-resolve.mjs govern every page.";

function retired() {
  return Response.json(
    {
      error: "canonical-apply-workflow-required",
      message: MESSAGE,
      dashboard: "http://127.0.0.1:7777",
      command: "npm run launch",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

// Fail closed for every former /api/apply/* operation. No request body is read,
// no browser/session is created, and no field can be filled through this path.
export async function GET() {
  return retired();
}

export async function POST() {
  return retired();
}

export async function PUT() {
  return retired();
}

export async function PATCH() {
  return retired();
}

export async function DELETE() {
  return retired();
}
