#!/usr/bin/env node
/**
 * snapshot-extract.mjs — parser for Playwright MCP accessibility snapshot files.
 *
 * The evidence-protocol v3 foundation: every
 * digest, field manifest, option list, upload-control manifest, and populated
 * value that the live-application receipt needs is derived HERE, by code, from
 * the snapshot files Playwright MCP already writes to `.playwright-mcp/` —
 * never typed by an agent. Degradation is always safe: anything the parser
 * cannot label or verify becomes a novel field or a warning, never wrong data.
 *
 * Input format (one node per line, 2-space indent tree):
 *   - textbox "First name" [ref=e143]: Neil
 *   - combobox [ref=e53]:
 *     - option "Please Select" [selected]
 *   - radio "Yes" [checked] [ref=e290] [cursor=pointer]
 *   - 'textbox "Email Address: *" [ref=f10e44]'
 *   - /placeholder: DD/MM/YYYY
 *   - text: 10/07/2029
 */

import { createHash } from 'crypto';
import { readFileSync, statSync, realpathSync } from 'fs';
import { basename, delimiter, isAbsolute, join, resolve, sep, dirname } from 'path';
import { fileURLToPath } from 'url';

import { isFinalApplicationActionLabel } from './application-safety.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── Evidence-path trust boundary (v3.1 §11) ─────────────────────────────────
//
// Snapshot/evidence files are agent-named paths, so they cross a filesystem
// trust boundary. Live snapshot evidence may only come from the Playwright MCP
// output directory; liveness evidence additionally from the dedicated
// application-evidence folder. Canonical resolution + realpath containment
// reject traversal, symlink escapes, and reads of unrelated files (secrets,
// user data). Tests may redirect the roots, but only through the same
// test-entrypoint gate the receipt module uses for its own path overrides.

const TEST_ENTRYPOINT = basename(process.argv[1] || '');

// Evaluated per call, not at module load: the suite imports this module before
// individual test files set NODE_ENV, while a production process can never
// satisfy the entrypoint check regardless of timing.
function testRootOverrideAllowed() {
  return process.env.NODE_ENV === 'test'
    && (TEST_ENTRYPOINT.endsWith('.test.mjs') || TEST_ENTRYPOINT === 'test-all.mjs');
}

function configuredRoots(envName, defaults) {
  const value = process.env[envName];
  if (!value) return defaults;
  if (!testRootOverrideAllowed()) {
    throw new Error(`${envName} is test-only and cannot redirect live snapshot evidence`);
  }
  return value.split(delimiter).filter(Boolean).map((entry) => resolve(entry));
}

export function snapshotEvidenceRoots() {
  return configuredRoots('CAREER_OPS_SNAPSHOT_ROOTS', [join(ROOT, '.playwright-mcp')]);
}

export function livenessEvidenceRoots() {
  return configuredRoots('CAREER_OPS_EVIDENCE_ROOTS', [
    join(ROOT, '.playwright-mcp'),
    join(ROOT, 'data', 'application-evidence'),
  ]);
}

/**
 * Canonicalize an evidence file path and enforce the trust boundary:
 * no null bytes, must exist, must be a regular file, and its realpath must
 * stay inside one of the allowed roots (symlink escapes rejected).
 */
export function resolveEvidencePath(path, roots) {
  const raw = String(path ?? '').trim();
  if (!raw) throw new Error('evidence path is required');
  if (raw.includes('\0')) throw new Error('evidence path contains a null byte');
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ROOT, raw);
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(`evidence file does not exist: ${raw}`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`evidence path is not a regular file: ${raw}`);
  const allowed = roots.some((root) => {
    let realRoot;
    try {
      realRoot = realpathSync(root);
    } catch {
      return false;
    }
    return real === realRoot || real.startsWith(realRoot + sep);
  });
  if (!allowed) {
    throw new Error(`evidence path is outside the approved evidence roots: ${raw}`);
  }
  return real;
}

/**
 * Read an evidence file's raw bytes with a replacement check: the file's
 * identity (inode/size/mtime) is compared before and after the read so a
 * swap between metadata check and hashing is detected. The digest is always
 * computed from the exact bytes read — the filename is never trusted.
 */
export function readEvidenceBytes(path, roots) {
  const real = resolveEvidencePath(path, roots);
  const before = statSync(real);
  const bytes = readFileSync(real);
  const after = statSync(real);
  if (before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs) {
    throw new Error(`evidence file changed while being read: ${path}`);
  }
  if (!bytes.length) throw new Error(`evidence file is empty: ${path}`);
  return {
    path: real,
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    observed_at: after.mtime.toISOString(),
  };
}

// ── Line grammar ─────────────────────────────────────────────────────────────

const ATTR_RE = /^\[([a-zA-Z-]+)(?:=([^\]]*))?\]\s*/;
// Roles are lowercase words; a few snapshots emit hyphenated roles.
const ROLE_RE = /^([a-z][a-z-]*)\b\s*/;

function unwrapYamlQuote(entry) {
  // `- 'textbox "Email: *" [ref=x]'` and `- 'button "..." [ref=x]': value`
  if (!entry.startsWith("'")) return { inner: entry, trailer: null };
  // Find the closing quote that is not doubled.
  for (let i = 1; i < entry.length; i += 1) {
    if (entry[i] !== "'") continue;
    if (entry[i + 1] === "'") { i += 1; continue; }
    const inner = entry.slice(1, i).replace(/''/g, "'");
    const rest = entry.slice(i + 1).trim();
    return { inner, trailer: rest.startsWith(':') ? rest.slice(1).trim() : null };
  }
  return { inner: entry, trailer: null };
}

function stripValueQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function parseEntry(rawEntry) {
  const { inner, trailer } = unwrapYamlQuote(rawEntry);
  let rest = inner;

  // Property lines: `/url: ...`, `/placeholder: DD/MM/YYYY`
  if (rest.startsWith('/')) {
    const idx = rest.indexOf(':');
    const key = idx === -1 ? rest.slice(1) : rest.slice(1, idx);
    const value = idx === -1 ? '' : stripValueQuotes(rest.slice(idx + 1));
    return { role: 'prop', prop: key.trim(), value, name: null, attrs: {}, hasChildrenMarker: false };
  }

  const roleMatch = rest.match(ROLE_RE);
  if (!roleMatch) {
    return { role: 'unknown', name: null, value: rest.trim(), attrs: {}, hasChildrenMarker: false };
  }
  const role = roleMatch[1];
  rest = rest.slice(roleMatch[0].length);

  // `text: value` / `generic: value` (role directly followed by colon-value)
  let name = null;
  if (rest.startsWith('"')) {
    // Quoted accessible name; find closing quote (no escaping observed in format).
    const end = rest.indexOf('"', 1);
    if (end !== -1) {
      name = rest.slice(1, end);
      rest = rest.slice(end + 1).trim();
    }
  }

  const attrs = {};
  let m;
  while ((m = rest.match(ATTR_RE))) {
    attrs[m[1]] = m[2] === undefined ? true : m[2];
    rest = rest.slice(m[0].length);
  }

  let value = null;
  let hasChildrenMarker = false;
  if (trailer !== null) {
    if (trailer === '') hasChildrenMarker = true;
    else value = stripValueQuotes(trailer);
  } else if (rest.startsWith(':')) {
    const after = rest.slice(1).trim();
    if (after === '') hasChildrenMarker = true;
    else value = stripValueQuotes(after);
  }

  return { role, name, value, attrs, hasChildrenMarker };
}

/**
 * Parse a snapshot's text into a node tree.
 * Node: { role, name, value, attrs, prop?, children[], parent }
 */
export function parseSnapshot(text) {
  const root = { role: 'root', name: null, value: null, attrs: {}, children: [], parent: null };
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of String(text).split('\n')) {
    if (!rawLine.trim()) continue;
    const indentMatch = rawLine.match(/^(\s*)- /);
    if (!indentMatch) continue; // non-node line (never observed inside snapshots)
    const indent = indentMatch[1].length;
    const entry = rawLine.slice(indentMatch[0].length).trim();
    const parsed = parseEntry(entry);

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = { ...parsed, children: [], parent };
    delete node.hasChildrenMarker;
    parent.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

function* walk(node) {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

function hasAncestorRole(node, roles) {
  for (let p = node.parent; p; p = p.parent) {
    if (roles.has(p.role)) return true;
  }
  return false;
}

function nearestAncestor(node, role) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.role === role) return p;
  }
  return null;
}

function textOf(node) {
  const own = node.name ?? node.value ?? '';
  return String(own).trim();
}

const LABEL_ROLES = new Set(['generic', 'text', 'paragraph', 'strong', 'term', 'cell', 'heading', 'emphasis']);

/** All visible text in a subtree, joined — labels are often nested in wrappers. */
function deepText(node, depth = 0) {
  if (depth > 4) return '';
  const parts = [];
  const own = textOf(node);
  if (own && own !== '*') parts.push(own);
  for (const child of node.children) {
    if (!LABEL_ROLES.has(child.role)) continue;
    const t = deepText(child, depth + 1);
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Nearest preceding label text for an unnamed control (same parent, then one level up). */
function fallbackLabel(node) {
  const scan = (siblings, before) => {
    const idx = siblings.indexOf(before);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const sib = siblings[i];
      if (LABEL_ROLES.has(sib.role)) {
        const t = deepText(sib);
        if (t && t !== '*') return t;
      }
    }
    return null;
  };
  if (node.parent) {
    const own = scan(node.parent.children, node);
    if (own) return own;
    // Label often names the wrapper: `generic "Legal Work Status:" > combobox`
    const parentText = node.parent.name ? String(node.parent.name).trim() : null;
    if (parentText) return parentText;
    if (node.parent.parent) {
      const up = scan(node.parent.parent.children, node.parent);
      if (up) return up;
    }
  }
  return null;
}

const CHROME_ROLES = new Set(['banner', 'contentinfo', 'navigation']);
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'checkbox']);
const OPTION_ROLES = new Set(['option', 'menuitem', 'gridcell']);

export function slugifyLabel(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unlabeled';
}

function isInnerDuplicate(node) {
  // `radio "Yes" > radio` / `checkbox "X" > checkbox`: the unnamed inner input.
  return !node.name && node.parent && node.parent.role === node.role;
}

/** Checked state may live on a nested inner input (`radio "Yes" > generic > radio [checked]`). */
function radioIsChecked(node) {
  for (const child of walk(node)) {
    if (child.role === 'radio' && child.attrs.checked) return true;
  }
  return false;
}

/**
 * Workable names each radio "<question text> <option text>"; strip the group
 * label prefix so options read "Yes" / "No" instead of the full question.
 */
function stripLabelPrefix(optionName, groupLabel) {
  const name = String(optionName ?? '').trim();
  const label = String(groupLabel ?? '').trim();
  if (label && name.length > label.length && name.startsWith(label)) {
    const stripped = name.slice(label.length).trim();
    if (stripped) return stripped;
  }
  return name;
}

function collectOptions(node) {
  const options = [];
  let selected = null;
  for (const child of walk(node)) {
    if (!OPTION_ROLES.has(child.role) || !child.name) continue;
    options.push(child.name);
    if (child.attrs.selected) selected = child.name;
  }
  return { options, selected };
}

function controlValue(node) {
  if (node.value != null && node.value !== '') return String(node.value);
  // `textbox:` with `/placeholder` + `text:` children (native date inputs)
  const textChild = node.children.find((c) => c.role === 'text' && c.value);
  if (textChild) return String(textChild.value);
  // `combobox:` with a single generic value child (intl phone widgets)
  const genericChildren = node.children.filter((c) => c.role === 'generic' && (c.value || c.name));
  if (genericChildren.length === 1) return textOf(genericChildren[0]);
  return '';
}

const PASSWORD_RE = /password/i;
const UPLOAD_BUTTON_RE = /choose file|upload|attach|browse for a file|add a document|replace file/i;
const OPTION_CAP = 200;

/**
 * Extract the editable-field manifest from a parsed snapshot tree.
 * Returns fields: { control_id, label, type, options, required, value, ref }.
 * Radio groups collapse to one field; password-labelled controls are excluded.
 */
/**
 * Some portals render radio options without a `radiogroup` ancestor. Grouping
 * them by their nearest shared container keeps "Yes/No" questions one logical
 * field (answer = checked option) instead of one impossible-to-answer field
 * per radio. A container yielding a single radio stays a singleton field.
 */
function groupUngroupedRadios(tree) {
  const loose = new Set([...walk(tree)].filter((node) =>
    node.role === 'radio' && node.name && !isInnerDuplicate(node) &&
    !nearestAncestor(node, 'radiogroup') && !hasAncestorRole(node, CHROME_ROLES)));
  const containsLooseRadios = (container) => {
    const members = [];
    for (const child of walk(container)) if (loose.has(child)) members.push(child);
    return members;
  };
  const byContainer = new Map();
  for (const radio of loose) {
    // Nearest ancestor (≤3 levels up) sharing at least one other loose radio.
    let found = null;
    let candidate = radio.parent;
    for (let depth = 0; candidate && depth < 3; depth += 1, candidate = candidate.parent) {
      if (containsLooseRadios(candidate).length > 1) { found = candidate; break; }
    }
    const key = found ?? radio;
    if (!byContainer.has(key)) byContainer.set(key, []);
    byContainer.get(key).push(radio);
  }
  return byContainer;
}

export function extractFields(tree) {
  const fields = [];
  const seenRadiogroups = new Set();
  const seenLooseRadios = new Set();
  const occurrence = new Map();
  const looseRadioGroups = groupUngroupedRadios(tree);
  const looseGroupByRadio = new Map();
  for (const [container, radios] of looseRadioGroups) {
    for (const radio of radios) looseGroupByRadio.set(radio, { container, radios });
  }

  const push = (label, type, { options = [], required = false, value = '', ref = null } = {}) => {
    const slug = slugifyLabel(label);
    const key = `${type}:${slug}`;
    const occ = (occurrence.get(key) ?? 0) + 1;
    occurrence.set(key, occ);
    fields.push({
      control_id: `${type}:${slug}:${occ}`,
      label: String(label).trim(),
      type,
      options: options.slice(0, OPTION_CAP),
      options_truncated: options.length > OPTION_CAP,
      required,
      value,
      ref,
    });
  };

  for (const node of walk(tree)) {
    if (hasAncestorRole(node, CHROME_ROLES)) continue;
    if (node.attrs?.disabled === true || node.attrs?.readonly === true) continue;

    if (node.role === 'radiogroup') {
      if (seenRadiogroups.has(node)) continue;
      seenRadiogroups.add(node);
      const radios = [...walk(node)].filter((n) => n.role === 'radio' && n.name);
      if (!radios.length) continue;
      const label = node.name || fallbackLabel(node) || radios.map((r) => r.name).join(' / ');
      if (PASSWORD_RE.test(label)) continue;
      const checked = radios.find((r) => r.attrs.checked || radioIsChecked(r));
      push(label, 'radio', {
        options: radios.map((r) => stripLabelPrefix(r.name, label)),
        value: checked ? stripLabelPrefix(checked.name, label) : '',
      });
      continue;
    }

    if (node.role === 'radio') {
      if (!node.name || isInnerDuplicate(node) || nearestAncestor(node, 'radiogroup')) continue;
      if (seenLooseRadios.has(node)) continue;
      const group = looseGroupByRadio.get(node);
      if (group && group.radios.length > 1) {
        for (const member of group.radios) seenLooseRadios.add(member);
        const label = fallbackLabel(group.container) || group.container.name ||
          group.radios.map((r) => r.name).join(' / ');
        if (PASSWORD_RE.test(label)) continue;
        const checked = group.radios.find((r) => r.attrs.checked || radioIsChecked(r));
        push(label, 'radio', {
          options: group.radios.map((r) => stripLabelPrefix(r.name, label)),
          value: checked ? stripLabelPrefix(checked.name, label) : '',
        });
        continue;
      }
      // Standalone named radio: its own yes-pick field.
      seenLooseRadios.add(node);
      if (PASSWORD_RE.test(node.name)) continue;
      push(node.name, 'radio', {
        options: [node.name],
        value: node.attrs.checked ? node.name : '',
      });
      continue;
    }

    if (!EDITABLE_ROLES.has(node.role)) continue;
    if (isInnerDuplicate(node)) continue;
    if (nearestAncestor(node, 'combobox') && node.role !== 'combobox') continue;
    // Combobox companion inputs (Workable/Humanforce render an unnamed
    // textbox/searchbox beside each combobox): skip when a combobox sibling exists.
    if (!node.name && (node.role === 'textbox' || node.role === 'searchbox') &&
        node.parent &&
        node.parent.children.some((c) => c !== node && c.role === 'combobox')) {
      continue;
    }

    const label = node.name || fallbackLabel(node);
    if (!label) {
      // Truly unlabeled control: keep it (novel-safe), positionally identified.
      const occKey = `${node.role}:unlabeled`;
      const occ = (occurrence.get(occKey) ?? 0) + 1;
      occurrence.set(occKey, occ);
      fields.push({
        control_id: `${node.role}:unlabeled:${occ}`,
        label: `unlabeled ${node.role} ${occ}`,
        type: node.role,
        options: [],
        options_truncated: false,
        required: false,
        value: controlValue(node),
        ref: node.attrs.ref ?? null,
      });
      continue;
    }
    if (PASSWORD_RE.test(label)) continue;
    // Anti-bot traps (Oracle HCM labels these "honeypot") are not candidate fields.
    if (/\bhoneypot\b/i.test(label)) continue;

    if (node.role === 'checkbox') {
      push(label, 'checkbox', {
        options: [label],
        value: node.attrs.checked ? label : '',
        ref: node.attrs.ref ?? null,
      });
      continue;
    }

    const { options, selected } = node.role === 'combobox'
      ? collectOptions(node)
      : { options: [], selected: null };
    push(label, node.role === 'searchbox' ? 'textbox' : node.role, {
      options,
      value: selected ?? controlValue(node),
      required: /\*/.test(label) || node.attrs.required === true,
      ref: node.attrs.ref ?? null,
    });
  }

  return fields;
}

const UPLOAD_KIND_RULES = [
  { kind: 'cv', re: /resume|\bcv\b|résumé/i },
  { kind: 'cover', re: /cover/i },
  { kind: 'supporting', re: /support|additional|document|evidence|portfolio/i },
];

function classifyUploadKind(contextText) {
  for (const rule of UPLOAD_KIND_RULES) {
    if (rule.re.test(contextText)) return rule.kind;
  }
  return 'other';
}

/**
 * Extract the upload-control manifest: { control_id, label, kind, required,
 * multiple, enabled, accepts }. `accepts` is null when the accessibility tree
 * does not expose it (the receipt schema allows null).
 */
export function extractUploadControls(tree) {
  const controls = [];
  const occurrence = new Map();
  for (const node of walk(tree)) {
    if (node.role !== 'button' || !node.name) continue;
    if (hasAncestorRole(node, CHROME_ROLES)) continue;
    if (!UPLOAD_BUTTON_RE.test(node.name)) continue;
    // Kind classification uses nearest context first so an adjacent section's
    // label ("Resume *") can never override the button's own zone label
    // ("Cover letter"): button name, then immediate sibling labels, then
    // ancestor names — the first layer that classifies wins.
    const layers = [node.name];
    if (node.parent) {
      layers.push(node.parent.children
        .filter((sibling) => sibling !== node && LABEL_ROLES.has(sibling.role))
        .map((sibling) => deepText(sibling)).join(' '));
    }
    let ancestors = '';
    for (let p = node.parent, depth = 0; p && depth < 4; p = p.parent, depth += 1) {
      if (p.name) ancestors += ` ${p.name}`;
    }
    layers.push(ancestors);
    let kind = 'other';
    for (const layer of layers) {
      const classified = classifyUploadKind(layer ?? '');
      if (classified !== 'other') { kind = classified; break; }
    }
    const context = layers.join(' ');
    const slug = slugifyLabel(node.name);
    const occ = (occurrence.get(slug) ?? 0) + 1;
    occurrence.set(slug, occ);
    controls.push({
      control_id: `upload:${slug}:${occ}`,
      label: node.name,
      kind,
      required: /\*|required/i.test(context),
      multiple: false,
      enabled: node.attrs.disabled !== true,
      accepts: null,
    });
  }
  return controls;
}

/**
 * Machine-detected validation alerts: `alert`/`alertdialog` nodes whose text
 * looks like a form error. Conservative on purpose — a missed alert is caught
 * by the candidate's combined review; a false positive would block a page.
 */
const VALIDATION_ALERT_RE = /required|invalid|error|must\b|please (fix|enter|select|complete|provide)/i;

export function extractValidationAlerts(tree) {
  const alerts = [];
  for (const node of walk(tree)) {
    if (node.role !== 'alert' && node.role !== 'alertdialog') continue;
    const text = [textOf(node), deepText(node)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (text && VALIDATION_ALERT_RE.test(text)) alerts.push(text.slice(0, 300));
  }
  return alerts;
}

/** Attachment chips: filenames the portal visibly renders (for displayed-name checks). */
export function extractDisplayedFilenames(tree) {
  const names = new Set();
  const FILE_RE = /[\w][\w .()-]*\.(pdf|docx?|rtf|odt|txt|html?)\b/gi;
  for (const node of walk(tree)) {
    const t = textOf(node);
    if (!t) continue;
    let m;
    while ((m = FILE_RE.exec(t))) names.add(m[0]);
  }
  return [...names];
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Conservative value normalization for machine comparison (v3.1 §7):
 * whitespace collapse, trim, NFKC unicode normalization, case fold. Anything
 * beyond this must NOT silently pass — callers surface it as a warning.
 */
export function normalizeValue(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

const normalize = normalizeValue;

/**
 * Critical-field classifier (v3.1 verification policy): identity, contact,
 * work-rights, and compensation answers must byte-verify in the after-fill
 * snapshot or the page hard-fails. Everything else may degrade to a warning
 * that is surfaced in the candidate's combined review.
 */
const CRITICAL_FIELD_RE = new RegExp([
  String.raw`\b(?:first|last|full|legal|family|given)\s+name\b`,
  'e-?mail', String.raw`\bphone\b`, String.raw`\bmobile\b`,
  'visa', String.raw`work(?:ing)?\s+rights`, 'right to work', 'citizen',
  'salary', 'compensation', 'remuneration', String.raw`notice\s+period`,
  String.raw`date\s+of\s+birth`,
].join('|'), 'i');

export function isCriticalField(label) {
  return CRITICAL_FIELD_RE.test(String(label ?? ''));
}

/**
 * Compare before/after field manifests (by control_id): which controls
 * appeared, disappeared, and stayed. Drives conditional-field re-lookup.
 */
export function compareFieldSets(beforeFields, afterFields) {
  const beforeIds = new Set(beforeFields.map((f) => f.control_id));
  const afterIds = new Set(afterFields.map((f) => f.control_id));
  return {
    added: afterFields.filter((f) => !beforeIds.has(f.control_id)),
    removed: beforeFields.filter((f) => !afterIds.has(f.control_id)),
    common: afterFields.filter((f) => beforeIds.has(f.control_id)),
  };
}

/**
 * Locate the final-submission boundary controls in a snapshot (machine-checked
 * complement of the never-submit rule — shares the canonical label regex with
 * application-safety.mjs). Returns [{ control_id, label, ref }].
 */
export function findSubmitBoundary(tree) {
  const found = [];
  for (const node of walk(tree)) {
    if ((node.role !== 'button' && node.role !== 'link') || !node.name) continue;
    if (!isFinalApplicationActionLabel(node.name)) continue;
    found.push({
      control_id: `${node.role}:${slugifyLabel(node.name)}`,
      label: node.name,
      ref: node.attrs.ref ?? null,
    });
  }
  return found;
}

/**
 * Verify expected answers against a parsed after-fill snapshot.
 * expected: [{ control_id, answer }] using v3 control_ids.
 * Returns per-field { control_id, verified, rendered } — long free text passes
 * on a normalized 80-char prefix match (snapshots occasionally reflow text).
 */
export function verifyPopulatedValues(tree, expected) {
  const fields = extractFields(tree);
  const byId = new Map(fields.map((f) => [f.control_id, f]));
  return expected.map(({ control_id, answer }) => {
    const field = byId.get(control_id);
    if (!field) return { control_id, verified: false, rendered: null, reason: 'control not found in after-snapshot' };
    const want = normalize(answer);
    const got = normalize(field.value);
    let verified = got === want;
    if (!verified && want.length > 80) verified = got.startsWith(want.slice(0, 80));
    if (!verified && field.type === 'checkbox') {
      const wantsChecked = !['', 'no', 'false', 'unchecked'].includes(want);
      verified = wantsChecked === (got !== '');
    }
    return {
      control_id,
      verified,
      rendered: field.value,
      ...(verified ? {} : { reason: 'rendered value does not match expected answer' }),
    };
  });
}

// ── File helpers ─────────────────────────────────────────────────────────────

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Read a snapshot file within the approved evidence roots.
 * Returns { path (canonical), text, tree, digest, observed_at } — the digest
 * is computed from the raw bytes read, never from the filename or a re-read.
 */
export function readSnapshotFile(path, roots = snapshotEvidenceRoots()) {
  const { path: real, bytes, digest, observed_at } = readEvidenceBytes(path, roots);
  const text = bytes.toString('utf8');
  return { path: real, text, tree: parseSnapshot(text), digest, observed_at };
}

// ── CLI (debug aid) ──────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [, , path] = process.argv;
  if (path) {
    const snap = readSnapshotFile(path);
    const fields = extractFields(snap.tree);
    const uploads = extractUploadControls(snap.tree);
    process.stdout.write(JSON.stringify({
      digest: snap.digest,
      observed_at: snap.observed_at,
      field_count: fields.length,
      fields,
      upload_controls: uploads,
      displayed_filenames: extractDisplayedFilenames(snap.tree),
    }, null, 2) + '\n');
  } else {
    process.stderr.write('Usage: node snapshot-extract.mjs <snapshot.yml>\n');
    process.exit(1);
  }
}
