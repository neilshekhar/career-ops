import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * ACL for the tracker-scoped subset of templates/states.yml — the SINGLE SOURCE
 * OF TRUTH for applications.md states. Per the
 * web↔core contract we READ it live and never hardcode the list (the maintainer
 * once mis-listed it from memory — the file had one more). The FALLBACK below is
 * only a last resort if the file is unreadable, and mirrors every scope:tracker entry.
 */
export type CanonicalState = {
  id: string;
  scope: "tracker";
  label: string;
  aliases: string[];
  description: string;
  group: string;
};

const FALLBACK: CanonicalState[] = [
  { id: "evaluated", scope: "tracker", label: "Evaluated", aliases: ["evaluada"], description: "Offer evaluated with report, pending decision", group: "evaluated" },
  { id: "applied", scope: "tracker", label: "Applied", aliases: ["aplicado", "enviada", "aplicada", "sent"], description: "Application submitted", group: "applied" },
  { id: "responded", scope: "tracker", label: "Responded", aliases: ["respondido"], description: "Company has responded (not yet interview)", group: "responded" },
  { id: "interview", scope: "tracker", label: "Interview", aliases: ["entrevista"], description: "Active interview process", group: "interview" },
  { id: "offer", scope: "tracker", label: "Offer", aliases: ["oferta"], description: "Offer received", group: "offer" },
  { id: "rejected", scope: "tracker", label: "Rejected", aliases: ["rechazado", "rechazada"], description: "Rejected by company", group: "rejected" },
  { id: "discarded", scope: "tracker", label: "Discarded", aliases: ["descartado", "descartada", "cerrada", "cancelada"], description: "Discarded by candidate or offer closed", group: "discarded" },
  { id: "skip", scope: "tracker", label: "SKIP", aliases: ["no_aplicar", "no aplicar", "skip", "monitor"], description: "Doesn't fit, don't apply", group: "skip" },
  { id: "hired", scope: "tracker", label: "Hired", aliases: ["contratado", "contratada", "hired", "accepted", "accept"], description: "Offer accepted, job landed!", group: "hired" },
];

let cache: CanonicalState[] | null = null;

export function readCanonicalStates(): CanonicalState[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path.join(careerOpsRoot(), "templates", "states.yml"), "utf8");
    const doc = yaml.load(raw) as { states?: unknown };
    const list = Array.isArray(doc?.states) ? doc.states : null;
    if (list && list.length) {
      const parsed: CanonicalState[] = [];
      for (const s of list as Record<string, unknown>[]) {
        if (!s || s.scope !== "tracker" || typeof s.label !== "string") continue;
        parsed.push({
          id: typeof s.id === "string" ? s.id : s.label.toLowerCase(),
          scope: "tracker",
          label: s.label,
          aliases: Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === "string") : [],
          description: typeof s.description === "string" ? s.description : "",
          group: typeof s.dashboard_group === "string" ? s.dashboard_group : (typeof s.id === "string" ? s.id : s.label.toLowerCase()),
        });
      }
      if (parsed.length) {
        cache = parsed;
        return parsed;
      }
    }
  } catch {
    /* fall through to fallback */
  }
  cache = FALLBACK;
  return FALLBACK;
}

export function canonicalLabels(): string[] {
  return readCanonicalStates().map((s) => s.label);
}

/** Map any raw status (label/id/alias, case-insensitive) to its canonical label,
 *  or null if unrecognized. */
export function canonicalizeStatus(raw: string): string | null {
  const q = raw.trim().toLowerCase().replace(/\*\*/g, "");
  if (!q) return null;
  for (const s of readCanonicalStates()) {
    if (s.label.toLowerCase() === q || s.id.toLowerCase() === q || s.aliases.some((a) => a.toLowerCase() === q)) {
      return s.label;
    }
  }
  return null;
}
