"use client";

import { ExternalLink, Lock } from "lucide-react";

// The web UI is a read/review surface. Live application execution belongs to the
// canonical localhost queue + active-agent workflow, which enforces the complete
// dashboard-first selection → PREPARE → per-page resolver/teach/verify loop. This
// CTA opens the dashboard before assets exist; PREPARE, not this report page,
// enforces the CV + cover + provenance gate.
export function ApplyButton({ url, company }: { url?: string; company: string }) {
  const hasUrl = !!url && /^https?:\/\//i.test(url);

  if (!hasUrl) {
    return (
      <button
        type="button"
        disabled
        title="No application URL on this report"
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border bg-surface/40 px-3.5 py-1 text-xs font-medium text-faint max-sm:min-h-[44px]"
      >
        <Lock className="size-3.5" /> Apply
      </button>
    );
  }
  return (
    <a
      href="http://127.0.0.1:7777"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-3.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
      title={`Open the canonical apply queue for ${company} in a new tab`}
    >
      <ExternalLink className="size-3.5" /> Apply queue
    </a>
  );
}
