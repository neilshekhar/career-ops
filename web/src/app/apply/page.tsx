import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default function ApplyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-6 text-brand" />
          <h1 className="font-display text-2xl tracking-tight text-landing">Canonical apply workflow</h1>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          The experimental web form proxy has been retired. Live applications now run only through the localhost apply
          queue and an active career-ops agent, so every wizard page uses the same lookup, L3 generation, teach,
          attachment, and verification checks.
        </p>
        <div className="mt-6 rounded-xl border border-border bg-background/60 p-4 text-sm leading-6 text-foreground">
          <p>
            Open the apply queue, select the role or roles, and ask your active CLI agent to continue applications. The
            agent handles the full form and stops only at the final submission control for your combined review.
          </p>
          <p className="mt-3 text-muted">
            If the dashboard is not running, start it from the repository root with <code>npm run launch</code>.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href="http://127.0.0.1:7777"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200"
          >
            Open apply queue <ExternalLink className="size-4" />
          </a>
          <Link
            href="/pipeline"
            className="inline-flex items-center rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-hover"
          >
            Back to pipeline
          </Link>
        </div>
      </div>
    </div>
  );
}
