/**
 * career-ops apply queue — SPA
 *
 * Fetches /api/queue, renders a 5-column kanban board grouped by pipeline stage
 * (Inbox / To Do / Prepared / In Review / Done), handles keyboard nav, inbox,
 * fill/submit/skip actions, search, threshold, bulk selection, parallel run,
 * and a live activity feed via SSE.
 * Risk lanes (needs-input / review-carefully) are shown as badges on cards.
 * The Done column is read-only, sourced from the tracker (applications.md).
 * Zero model tokens — pure DOM + fetch.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let allRoles   = [];
let doneRows   = []; // tracker-sourced Done column rows (read-only)
let settings   = { score_threshold: null };
let query      = '';

// cursor: { stageKey, idx } — which card is highlighted (Done column not navigable)
let cursor     = { stageKey: 'inbox', idx: 0 };
let activeId   = null; // ID of the role open in inbox

// Bulk selection
let checkedIds = new Set();

// Keyboard-navigable stage columns, left to right. 'done' is render-only.
const STAGE_NAV = ['inbox', 'todo', 'prepared', 'review'];

// Risk-lane badge (orthogonal to stage): how carefully to look at the card.
const LANE_BADGE = {
  'needs-input':      '<span class="badge badge-lane-needs"  title="Has unresolved custom/manual fields">⚠ needs input</span>',
  'review-carefully': '<span class="badge badge-lane-review" title="Eligibility / ambiguity / low confidence — review carefully">🔶 review</span>',
};

// ── Drag-and-drop ────────────────────────────────────────────────────────────
//
// Most column boundaries on this board aren't a bare relabel — Prepared needs a
// real tailored CV + cover letter, In Review needs a real form-fill, Done needs
// a real submission. So a drop either (a) writes a pure status flip via
// POST /api/role/:id/stage — only Inbox↔To Do and Prepared/In Review→To Do
// qualify — or (b) triggers the exact same action the Fill Form / Mark Submitted
// buttons already call, or (c) is rejected with an explanatory toast. Nothing
// here ever lets a card claim to be further along than it actually is.

let dragSource = null; // { id, stage } of the card currently being dragged

const STAGE_LABEL = { inbox: 'Inbox', todo: 'To Do', prepared: 'Prepared', review: 'In Review', done: 'Done' };

// target stage → { sourceStage: action }
const DROP_ACTIONS = {
  todo:   { inbox: 'stage-flip', prepared: 'stage-flip', review: 'stage-flip' },
  inbox:  { todo: 'stage-flip' },
  review: { prepared: 'fill' },
  done:   { review: 'submit' },
};

function dropActionFor(fromStage, toStage) {
  if (fromStage === toStage) return null;
  return DROP_ACTIONS[toStage]?.[fromStage] ?? null;
}

function clearDropZoneHighlights() {
  document.querySelectorAll('.lane').forEach(l => l.classList.remove('lane-drop-valid', 'lane-drop-invalid'));
}

function setupDragAndDrop() {
  document.querySelectorAll('.lane[data-stage]').forEach((lane) => {
    const stage = lane.dataset.stage;

    lane.addEventListener('dragover', (e) => {
      if (!dragSource) return;
      const action = dropActionFor(dragSource.stage, stage);
      if (action) {
        e.preventDefault(); // permits the drop; otherwise the browser shows its native no-drop cursor
        e.dataTransfer.dropEffect = 'move';
        lane.classList.add('lane-drop-valid');
        lane.classList.remove('lane-drop-invalid');
      } else if (dragSource.stage !== stage) {
        lane.classList.add('lane-drop-invalid');
        lane.classList.remove('lane-drop-valid');
      }
    });

    lane.addEventListener('dragleave', (e) => {
      if (!lane.contains(e.relatedTarget)) {
        lane.classList.remove('lane-drop-valid', 'lane-drop-invalid');
      }
    });

    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('lane-drop-valid', 'lane-drop-invalid');
      if (!dragSource) return;
      const { id, stage: fromStage } = dragSource;
      handleDrop(id, fromStage, stage);
    });
  });
}

async function handleDrop(id, fromStage, toStage) {
  if (fromStage === toStage) return; // dropped back in the same column — no-op

  const action = dropActionFor(fromStage, toStage);
  const role = allRoles.find(r => r.id === id);
  const name = role ? `${role.company} – ${role.title}` : 'This role';

  if (!action) {
    if (toStage === 'prepared') {
      toast("Prepared requires generating a tailored CV + cover letter — run /career-ops queue prepare (can't skip asset generation)", 5000);
    } else {
      toast(`Can't move a role from ${STAGE_LABEL[fromStage]} to ${STAGE_LABEL[toStage]} by dragging — use the existing workflow`, 4000);
    }
    return;
  }

  if (action === 'stage-flip') {
    try {
      const res = await fetch(`/api/role/${encodeURIComponent(id)}/stage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ stage: toStage }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Move failed', 3000);
        return;
      }
      // A send-back revert leaves the old CV/cover letter on the role — remind
      // that PREPARE must regenerate them before the next fill.
      if (toStage === 'todo' && (fromStage === 'prepared' || fromStage === 'review')) {
        toast(`${name} sent back to To Do — run /career-ops queue prepare to regenerate assets before filling`, 5000);
      } else {
        toast(`${name} moved to ${STAGE_LABEL[toStage]}`);
      }
      await loadQueue();
    } catch {
      toast('Move failed — check server logs', 4000);
    }
    return;
  }

  if (action === 'fill') {
    await doFill(id);
    return;
  }

  if (action === 'submit') {
    // Mirror the inbox panel's guard (its Submit button is disabled for
    // prefilled) — don't offer a confirm the decision path will refuse.
    if (role?.status === 'prefilled') {
      toast('Re-open with headed Fill Form and review before marking submitted.', 4000);
      return;
    }
    confirmToast(`Mark ${name} as submitted?`, () => doDecision('submitted', id));
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadQueue();
  connectActivityFeed();
});

// ── Data ──────────────────────────────────────────────────────────────────────

async function loadQueue() {
  try {
    const res  = await fetch('/api/queue');
    const data = await res.json();
    allRoles = data.roles || [];
    doneRows = data.done  || [];
    settings = data.settings || {};
    if (settings.score_threshold) {
      document.getElementById('threshold-input').value = settings.score_threshold;
    }
    syncAutoFillAllButton();
    renderAll(data.stats);
    syncBatchBar();
  } catch (err) {
    console.error('Failed to load queue:', err);
    toast('Failed to load queue — is the server running?', 4000);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function stageMapFor(roles) {
  const map = { inbox: [], todo: [], prepared: [], review: [] };
  for (const role of roles) {
    if (map[role.stage]) map[role.stage].push(role);
  }
  for (const k of STAGE_NAV) {
    map[k].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return map;
}

function filterRoles(roles) {
  if (!query) return roles;
  return roles.filter(r =>
    r.company.toLowerCase().includes(query) ||
    r.title.toLowerCase().includes(query) ||
    (r.location || '').toLowerCase().includes(query));
}

function renderAll(stats) {
  updateStats(stats);

  const stageMap = stageMapFor(filterRoles(allRoles));

  renderLane('inbox',    stageMap.inbox);
  renderLane('todo',     stageMap.todo);
  renderLane('prepared', stageMap.prepared);
  renderLane('review',   stageMap.review);
  renderTodoCta(stageMap.todo.length);
  renderDoneLane();

  // Update inbox if one is open
  if (activeId) {
    const role = allRoles.find(r => r.id === activeId);
    if (role) renderInbox(role);
  }
}

function updateStats(stats) {
  if (!stats) return;
  document.getElementById('stat-new').textContent          = stats.newCount ?? 0;
  document.getElementById('stat-inbox').textContent        = stats.inbox ?? 0;
  document.getElementById('stat-todo').textContent         = stats.todo ?? 0;
  document.getElementById('stat-prepared').textContent     = stats.prepared ?? 0;
  document.getElementById('stat-review-stage').textContent = stats.review ?? 0;
  document.getElementById('stat-done').textContent         = doneRows.length;
  document.getElementById('stat-avg').textContent          = stats.avgScore != null ? stats.avgScore + '/5' : '—';
}

// To Do column call-to-action: these roles are selected but waiting for the
// agent-driven PREPARE step (tailored CV + cover letter + field drafts) —
// the dashboard itself cannot generate assets.
function renderTodoCta(count) {
  const cta = document.getElementById('cta-todo');
  if (count > 0) {
    document.getElementById('cta-todo-text').textContent =
      `${count} waiting for PREPARE — run /career-ops queue prepare (generates tailored CV + cover letter)`;
    cta.removeAttribute('hidden');
  } else {
    cta.setAttribute('hidden', '');
  }
}

function renderLane(stageKey, roles) {
  const container = document.getElementById(`cards-${stageKey}`);
  const countEl   = document.getElementById(`count-${stageKey}`);
  countEl.textContent = roles.length;

  container.innerHTML = '';

  if (roles.length === 0) {
    container.innerHTML = '<p class="lane-empty">No roles</p>';
    return;
  }

  roles.forEach((role, idx) => {
    const card = buildCard(role, stageKey, idx);
    container.appendChild(card);
  });

  syncCursorHighlight();
}

// Done column — read-only cards from the tracker. Applied-group rows first
// (Applied / Responded / Interview / Offer), then a collapsed Closed group
// (Rejected / Discarded / SKIP).
function renderDoneLane() {
  const container = document.getElementById('cards-done');
  const countEl   = document.getElementById('count-done');

  const q = query;
  const visible = q
    ? doneRows.filter(r =>
        r.company.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q))
    : doneRows;

  const applied = visible.filter(r => r.group === 'applied');
  const closed  = visible.filter(r => r.group === 'closed');

  countEl.textContent = visible.length;
  container.innerHTML = '';

  if (visible.length === 0) {
    container.innerHTML = '<p class="lane-empty">Nothing applied yet</p>';
    return;
  }

  for (const row of applied) container.appendChild(buildDoneCard(row));

  if (closed.length > 0) {
    const details = document.createElement('details');
    details.className = 'done-closed';
    details.innerHTML = `<summary>Closed (${closed.length})</summary>`;
    for (const row of closed) details.appendChild(buildDoneCard(row));
    container.appendChild(details);
  }
}

function buildDoneCard(row) {
  const card = document.createElement('div');
  card.className = 'card card-done';

  const statusClass = row.group === 'applied' ? 'badge-done-applied' : 'badge-done-closed';
  const icon        = row.group === 'applied' ? '✅' : '·';

  card.innerHTML = `
    <div class="card-body">
      <div class="card-title">${icon} ${esc(row.title)}</div>
      <div class="card-company">${esc(row.company)}</div>
      <div class="card-badges">
        <span class="badge ${statusClass}">${esc(row.status)}</span>
        ${row.date ? `<span class="badge badge-flag">${esc(row.date)}</span>` : ''}
        ${row.score && row.score !== 'N/A' ? `<span class="badge badge-flag">${esc(row.score)}</span>` : ''}
      </div>
    </div>`;
  return card;
}

function buildCard(role, stageKey, idx) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id    = role.id;
  card.dataset.stage = stageKey;
  card.dataset.idx   = idx;
  card.tabIndex = -1;
  card.draggable = true;

  if (checkedIds.has(role.id)) card.classList.add('checked');

  const scoreClass = scoreColorClass(role.score);

  // Employment type badge
  const typeBadge = role.employment_type === 'full-time'  ? '<span class="badge badge-ft">FT</span>'
                  : role.employment_type === 'part-time'   ? '<span class="badge badge-pt">PT</span>'
                  : role.employment_type === 'ambiguous'   ? '<span class="badge badge-ambig">?</span>'
                  : '';

  // Visa badge
  const visaText = role.visa_answer || '';
  const visaBadge = visaText ? `<span class="badge badge-visa">${esc(visaText)}</span>` : '';

  // Status badge — only where the column doesn't already convey it:
  // filled vs prefilled share the In Review column, so keep that distinction.
  const statusBadge = role.status === 'filled'   ? '<span class="badge badge-filled">Filled</span>'
                    : role.status === 'prefilled' ? '<span class="badge badge-prefilled">Prefilled</span>'
                    : '';

  // Risk-lane badge (orthogonal to the stage column)
  const laneBadge = LANE_BADGE[role.lane] || '';

  // Eligibility badge
  const eligBadge = role.eligibility === 'cap'    ? '<span class="badge badge-cap">Cap</span>'
                  : role.eligibility === 'blocked' ? '<span class="badge badge-blocked">Blocked</span>'
                  : '';

  // Login-gated badge
  const loginBadge = (role.flags || []).includes('login-required')
    ? '<span class="badge badge-login" title="Portal requires login">🔐 login</span>'
    : '';

  // Documents-required badges
  const kscBadge = (role.flags || []).includes('ksc-required')
    ? '<span class="badge badge-doc" title="Key Selection Criteria required">📋 KSC</span>'
    : '';
  const coverBadge = (role.flags || []).includes('cover-letter-required')
    ? '<span class="badge badge-doc" title="Cover letter required">📄 cover</span>'
    : '';

  // Knockout flag badge
  const koBadge = (role.flags || []).includes('knockout-flag')
    ? '<span class="badge badge-ko" title="Screener/knockout question detected">⛔ screener</span>'
    : '';

  // Deep-eval marker badge (set from the inbox ★ button; honoured at apply time)
  const deepBadge = (role.flags || []).includes('deep-eval')
    ? '<span class="badge badge-deep" title="Marked for a full oferta evaluation before applying">★ deep-eval</span>'
    : '';

  // Auto-fill marker badge (set from the inbox ⚡ button; honoured at PREPARE time:
  // the fill launches right after assets are generated instead of parking at Prepared)
  const autoBadge = (role.flags || []).includes('auto-fill')
    ? '<span class="badge badge-auto" title="One-shot: PREPARE chains straight into the fill (still never submits)">⚡ auto-fill</span>'
    : '';

  // Extra flags (first 2, excluding well-known ones)
  const HANDLED_FLAGS = new Set([
    'ambiguous-employment', 'large-co-visa-cap', 'pr-citizenship-required',
    'login-required', 'ksc-required', 'cover-letter-required', 'knockout-flag',
    'manual-field', 'deep-eval', 'auto-fill',
  ]);
  const extraFlags = (role.flags || [])
    .filter(f => !HANDLED_FLAGS.has(f))
    .slice(0, 2)
    .map(f => `<span class="badge badge-flag">${esc(f)}</span>`)
    .join('');

  // Provenance summary
  const provBadge = role.provenance_summary
    ? `<span class="badge badge-prov" title="Fill provenance">${esc(role.provenance_summary)}</span>`
    : '';

  // Checkbox
  const checkHtml = `<input type="checkbox" class="card-checkbox" data-id="${esc(role.id)}" ${checkedIds.has(role.id) ? 'checked' : ''} aria-label="Select ${esc(role.company)}">`;

  card.innerHTML = `
    <div class="card-check">${checkHtml}</div>
    <div class="card-score-badge ${scoreClass}">${role.score != null ? role.score.toFixed(1) : '—'}</div>
    <div class="card-body">
      <div class="card-title">${esc(role.title)}</div>
      <div class="card-company">${esc(role.company)}${role.location ? ' · ' + esc(role.location) : ''}</div>
      <div class="card-url"><a href="${esc(role.url)}" target="_blank" rel="noopener" class="card-url-link" title="${esc(role.url)}">${esc(truncateUrl(role.url))}</a></div>
      <div class="card-badges">
        ${laneBadge}${typeBadge}${visaBadge}${eligBadge}${statusBadge}${loginBadge}${kscBadge}${coverBadge}${koBadge}${deepBadge}${autoBadge}${extraFlags}
      </div>
      ${provBadge ? `<div class="card-prov">${provBadge}</div>` : ''}
      ${role.requirements_snippet ? `<div class="card-snippet">${esc(role.requirements_snippet.slice(0, 120))}…</div>` : ''}
    </div>`;

  // Checkbox toggle (does not open inbox)
  const chkEl = card.querySelector('.card-checkbox');
  chkEl.addEventListener('change', (e) => {
    e.stopPropagation();
    toggleCheck(role.id, e.target.checked);
  });
  chkEl.addEventListener('click', (e) => e.stopPropagation());

  // Card body click → open inbox
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-checkbox') || e.target.closest('.card-url-link')) return;
    cursor = { stageKey, idx };
    syncCursorHighlight();
    openInbox(role.id);
  });

  // Drag source
  card.addEventListener('dragstart', (e) => {
    dragSource = { id: role.id, stage: stageKey };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', role.id);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragSource = null;
    clearDropZoneHighlights();
  });

  return card;
}

function truncateUrl(url = '') {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname);
  } catch {
    return url.slice(0, 50);
  }
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

function openInbox(id) {
  activeId = id;
  const role = allRoles.find(r => r.id === id);
  if (!role) return;
  renderInbox(role);
  document.getElementById('inbox').removeAttribute('hidden');
}

function closeInbox() {
  activeId = null;
  document.getElementById('inbox').setAttribute('hidden', '');
}

function renderInbox(role) {
  document.getElementById('inbox-title').textContent = `${role.title} · ${role.company}`;

  const body       = document.getElementById('inbox-body');
  const scoreClass = scoreColorClass(role.score);

  const typeLine = role.employment_type === 'full-time'  ? 'Full-time'
                 : role.employment_type === 'part-time'   ? 'Part-time'
                 : role.employment_type === 'ambiguous'   ? '⚠ Ambiguous (review type)'
                 : '—';

  const visaLine = role.visa_answer
    ? `<span class="badge badge-visa">${esc(role.visa_answer)}</span>`
    : '<span class="badge badge-ambig">No visa answer — review type first</span>';

  const freeTextSections = buildFreeTextSections(role);
  const manualFields     = buildManualFields(role);
  const docSection       = buildDocSection(role);

  const flagsHtml = (role.flags || []).length > 0
    ? `<div class="inbox-section">
        <div class="inbox-section-label">Flags</div>
        <div class="flags-list">${(role.flags || []).map(f => `<span class="badge badge-flag">${esc(f)}</span>`).join('')}</div>
      </div>`
    : '';

  const cvHtml = role.cv_pdf
    ? `<div class="inbox-section">
        <div class="inbox-section-label">Tailored CV PDF</div>
        <div class="inbox-section-value">${esc(role.cv_pdf)}</div>
      </div>`
    : `<div class="inbox-section">
        <div class="inbox-section-value" style="color:var(--overlay0)">CV not yet generated — run <code>/career-ops queue prepare</code></div>
      </div>`;

  const provHtml = role.provenance_summary
    ? `<div class="inbox-section">
        <div class="inbox-section-label">Fill provenance</div>
        <div class="inbox-section-value" style="color:var(--subtext)">${esc(role.provenance_summary)}</div>
      </div>`
    : '';

  const snippetHtml = role.requirements_snippet
    ? `<div class="inbox-section">
        <div class="inbox-section-label">Requirements (from JD)</div>
        <div class="inbox-section-value" style="color:var(--subtext);white-space:pre-wrap">${esc(role.requirements_snippet)}</div>
      </div>`
    : '';

  body.innerHTML = `
    <div class="inbox-meta">
      <span class="inbox-score ${scoreClass}">${role.score != null ? role.score.toFixed(1) + '/5' : '—'}</span>
      <span class="badge ${role.employment_type === 'part-time' ? 'badge-pt' : role.employment_type === 'ambiguous' ? 'badge-ambig' : 'badge-ft'}">${esc(typeLine)}</span>
      <span class="badge badge-flag">${esc(role.size_bucket || 'unknown')}</span>
      ${role.eligibility !== 'ok' ? `<span class="badge badge-${role.eligibility === 'blocked' ? 'blocked' : 'cap'}">${esc(role.eligibility)}</span>` : ''}
      ${role.status === 'filled' ? '<span class="badge badge-filled">Filled ✓</span>' : ''}
      ${role.status === 'prefilled' ? '<span class="badge badge-prefilled">Prefilled</span>' : ''}
    </div>

    ${role.reason ? `<div class="inbox-reason">${esc(role.reason)}</div>` : ''}

    <div class="inbox-url">
      <a href="${esc(role.url)}" target="_blank" rel="noopener">Open posting ↗</a>
      <span class="inbox-url-text">${esc(role.url)}</span>
    </div>

    <div class="inbox-section">
      <div class="inbox-section-label">Visa answer</div>
      <div>${visaLine}</div>
    </div>

    ${flagsHtml}
    ${snippetHtml}
    ${docSection}
    ${freeTextSections}
    ${manualFields}
    ${cvHtml}
    ${provHtml}
  `;

  const note = document.getElementById('inbox-note');
  const submitBtn = document.getElementById('btn-submit');
  const isPrefilled = role.status === 'prefilled';
  submitBtn.disabled = isPrefilled;
  submitBtn.title = isPrefilled
    ? 'Re-open with headed Fill Form and review before marking submitted'
    : 'Mark submitted after manual submission';

  const deepBtn = document.getElementById('btn-deep-eval');
  if (deepBtn) {
    const marked = (role.flags || []).includes('deep-eval');
    deepBtn.classList.toggle('active', marked);
    deepBtn.textContent = marked ? '★ Deep-eval ✓' : '★ Deep-eval';
    deepBtn.title = marked
      ? 'Marked — a full oferta runs before applying. Click to unmark.'
      : 'Mark this role as worth a full oferta evaluation before applying';
  }

  const autoBtn = document.getElementById('btn-auto-fill');
  if (autoBtn) {
    const marked = (role.flags || []).includes('auto-fill');
    autoBtn.classList.toggle('active', marked);
    autoBtn.textContent = marked ? '⚡ Auto-fill ✓' : '⚡ Auto-fill';
    autoBtn.title = marked
      ? 'One-shot on — PREPARE chains straight into the fill. Click to unmark.'
      : 'One-shot: PREPARE chains straight into the fill (still never submits)';
  }

  if (role.employment_type === 'ambiguous') {
    note.textContent = '⚠ Employment type is ambiguous — confirm before filling.';
  } else if (role.eligibility === 'blocked') {
    note.textContent = '⛔ Eligibility blocker — confirm manually before applying.';
  } else if ((role.flags || []).includes('knockout-flag')) {
    note.textContent = '⛔ Screener/knockout question detected — answer truthfully in the browser.';
  } else if (isPrefilled) {
    note.textContent = 'Headless pre-fill completed. Click Fill Form to re-open headed, review the live form, then submit manually.';
  } else if ((role.flags || []).includes('login-required')) {
    note.textContent = '🔐 Portal requires login — form-fill will handle registration/login automatically.';
  } else if (!role.cv_pdf) {
    note.textContent = 'Run /career-ops queue prepare to generate a tailored CV.';
  } else if (role.status === 'scored' || role.status === 'prepare-queued') {
    // A cv_pdf on a pre-PREPARE status means the role was sent back for redo —
    // the assets on record are from the earlier PREPARE run and must be
    // regenerated before filling.
    note.textContent = '↩ Assets are from an earlier PREPARE — run /career-ops queue prepare to regenerate before filling.';
  } else if (role.status === 'filled') {
    note.textContent = 'Form filled — review in browser, then submit manually and click Mark Submitted.';
  } else {
    note.textContent = 'Submit only after reviewing the filled form. Never auto-submitted.';
  }
}

function buildDocSection(role) {
  const items = [];
  if ((role.flags || []).includes('ksc-required')) {
    const criteria = role.ksc_criteria?.length
      ? `<ul class="ksc-list">${role.ksc_criteria.slice(0, 5).map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
      : '<span style="color:var(--overlay0)">Criteria will be extracted during prepare</span>';
    items.push(`<div><div class="inbox-section-label">📋 Key Selection Criteria</div>${criteria}</div>`);
  }
  if ((role.flags || []).includes('cover-letter-required')) {
    const path = role.cover_letter_path
      ? `<div class="inbox-section-value">${esc(role.cover_letter_path)}</div>`
      : '<div style="color:var(--overlay0)">Not yet generated — run /career-ops queue prepare</div>';
    items.push(`<div><div class="inbox-section-label">📄 Cover letter</div>${path}</div>`);
  }
  if (items.length === 0) return '';
  return `<div class="inbox-section">${items.join('')}</div>`;
}

function buildFreeTextSections(role) {
  if (!role.free_text_fields || role.free_text_fields.length === 0) return '';
  const standards = role.free_text_fields.filter(f => f.kind === 'standard');
  if (standards.length === 0) return '';

  const items = standards.map(f => {
    const draft = role.drafts && role.drafts[f.key];
    const content = draft
      ? `<div class="draft-block">${esc(typeof draft === 'object' ? draft.answer : draft)}</div>`
      : `<div class="draft-block"><span class="draft-placeholder">Not yet drafted — run /career-ops queue prepare</span></div>`;
    return `<div><div class="inbox-section-label" style="margin-bottom:4px">${esc(f.label)}</div>${content}</div>`;
  }).join('');

  return `<div class="inbox-section">
    <div class="inbox-section-label">Standard free-text fields</div>
    ${items}
  </div>`;
}

function buildManualFields(role) {
  if (!role.free_text_fields || role.free_text_fields.length === 0) return '';
  const customs = role.free_text_fields.filter(f => f.kind === 'custom');
  if (customs.length === 0 && !(role.flags || []).includes('manual-field')) return '';

  const items = customs.map(f =>
    `<div class="manual-field-item">
      <div class="field-label">${esc(f.label)}${f.required ? ' *' : ''}</div>
      <div class="field-note">Custom field — fill manually</div>
    </div>`
  ).join('');

  return `<div class="inbox-section">
    <div class="inbox-section-label" style="color:var(--yellow)">⚠ Manual fields (left blank by auto-fill)</div>
    ${items || '<div class="inbox-section-value" style="color:var(--overlay0)">See flags — manual input required</div>'}
  </div>`;
}

// ── Bulk selection ────────────────────────────────────────────────────────────

function toggleCheck(id, checked) {
  if (checked) checkedIds.add(id);
  else          checkedIds.delete(id);
  syncBatchBar();
  // Update card class without full re-render
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('checked', checked);
}

function syncBatchBar() {
  const bar       = document.getElementById('batch-bar');
  const countEl   = document.getElementById('batch-count');
  const n         = checkedIds.size;
  bar.hidden      = n === 0;
  countEl.textContent = `${n} selected`;
}

function selectAll() {
  const threshold = settings.score_threshold ?? 0;
  for (const role of allRoles) {
    if (role.score != null && role.score >= threshold) {
      checkedIds.add(role.id);
    }
  }
  renderAll(); // re-render to show checkmarks
  syncBatchBar();
}

function clearAll() {
  checkedIds.clear();
  renderAll();
  syncBatchBar();
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function startRun() {
  if (checkedIds.size === 0) { toast('No roles selected', 2000); return; }

  // Show activity panel
  document.getElementById('activity-panel').removeAttribute('hidden');

  const ids = Array.from(checkedIds);
  try {
    const res  = await fetch('/api/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ids }),
    });
    const data = await res.json();
    const skippedNote = data.notPrepared > 0
      ? `, ${data.notPrepared} skipped (not prepared — run /career-ops queue prepare)`
      : '';
    const headedCount = (data.loginGated ?? 0) + (data.headedReopen ?? 0);
    toast(`Run started: ${data.deterministic} headless, ${headedCount} headed, ${data.agentPath} agent-path${skippedNote}`, data.notPrepared > 0 ? 5000 : 2500);
    clearAll();
  } catch {
    toast('Failed to start run — check server logs', 4000);
  }
}

// ── Activity feed (SSE) ───────────────────────────────────────────────────────

let eventSource = null;

function connectActivityFeed() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/activity');
  eventSource.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      appendActivityEntry(entry);
    } catch {}
  };
  eventSource.onerror = () => {
    // Reconnect silently — SSE will retry automatically
  };
}

// A fill runs as a detached child process, so the board can't know when the
// status actually advances — the SSE terminal events are that signal. Debounced
// so a bulk run's burst of events triggers one reload, not one per role.
let activityReloadTimer;
const ACTIVITY_TERMINAL_EVENTS = new Set(['success', 'failure', 'login-wall', 'knockout-flag']);

function appendActivityEntry(entry) {
  if (ACTIVITY_TERMINAL_EVENTS.has(entry.event)) {
    clearTimeout(activityReloadTimer);
    activityReloadTimer = setTimeout(loadQueue, 1500);
  }

  const body = document.getElementById('activity-body');

  const icon = {
    started:     '⏳',
    success:     '✅',
    'login-wall':    '🔐',
    'knockout-flag': '⛔',
    failure:     '❌',
    'agent-path':    '🤖',
  }[entry.event] || '·';

  const row = document.createElement('div');
  row.className = `activity-row activity-${entry.event}`;
  row.innerHTML = `
    <span class="activity-icon">${icon}</span>
    <span class="activity-company">${esc(entry.company)} – ${esc(entry.title)}</span>
    <span class="activity-event">${esc(entry.event)}</span>
    ${entry.message ? `<span class="activity-msg">${esc(entry.message)}</span>` : ''}
    <span class="activity-ts">${entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''}</span>
  `;
  body.prepend(row); // newest first

  // Highlight updated card
  if (entry.roleId) {
    const card = document.querySelector(`.card[data-id="${CSS.escape(entry.roleId)}"]`);
    if (card) {
      card.classList.add('activity-flash');
      setTimeout(() => card.classList.remove('activity-flash'), 2000);
    }
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function doFill(roleId = activeId) {
  if (!roleId) return;
  try {
    const res  = await fetch(`/api/role/${encodeURIComponent(roleId)}/fill`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Fill failed — check server logs', 4000);
      return;
    }
    const data = await res.json();
    if (data.method === 'agent') {
      toast(data.message, 6000);
    } else {
      toast('Playwright fill launched — browser opening…');
    }
    // The fill runs as a detached child process, so status hasn't advanced yet;
    // this refresh only picks up stats/settings. The card moves on a later
    // refresh once form-fill.mjs persists the new status.
    await loadQueue();
  } catch {
    toast('Fill request failed — check server logs', 4000);
  }
}

async function doDecision(decision, roleId = activeId) {
  if (!roleId) return;
  const role = allRoles.find(r => r.id === roleId);
  if (decision === 'submitted' && role?.status === 'prefilled') {
    toast('Re-open with headed Fill Form and review before marking submitted.', 4000);
    return;
  }
  const label = { submitted: 'Submitted', skipped: 'Skipped', reviewed: 'Reviewed' }[decision];
  try {
    const res = await fetch(`/api/role/${encodeURIComponent(roleId)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) { toast('Action failed', 3000); return; }
    toast(`${label} — advancing to next role…`);
    const wasActive = roleId === activeId;
    if (wasActive) closeInbox();
    await loadQueue();
    // Keyboard-driven decisions advance the cursor; a drag-triggered decision
    // on an unrelated card only restores the highlight renderAll() wiped,
    // without repositioning or scrolling the user's keyboard cursor.
    if (wasActive) advanceCursor();
    else syncCursorHighlight();
  } catch {
    toast('Action failed — check server logs', 4000);
  }
}

// Shared marker toggle — deep-eval and auto-fill both go through the /flag
// endpoint (marker only: never touches status, lane, or the fill pipeline).
async function toggleRoleFlag(flag, { onMsg, offMsg }) {
  if (!activeId) return;
  const role = allRoles.find(r => r.id === activeId);
  const marked = (role?.flags || []).includes(flag);
  try {
    const res = await fetch(`/api/role/${encodeURIComponent(activeId)}/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag, value: !marked }),
    });
    if (!res.ok) { toast('Could not update mark', 3000); return; }
    const data = await res.json();
    toast(data.marked ? onMsg : offMsg);
    await loadQueue();
    const updated = allRoles.find(r => r.id === activeId);
    if (updated) renderInbox(updated);
  } catch {
    toast('Mark update failed — check server logs', 4000);
  }
}

async function toggleDeepEval() {
  return toggleRoleFlag('deep-eval', {
    onMsg:  '★ Marked — full oferta will run before applying',
    offMsg: 'Deep-eval mark removed',
  });
}

async function toggleAutoFill() {
  return toggleRoleFlag('auto-fill', {
    onMsg:  '⚡ One-shot on — PREPARE will chain straight into the fill (never submits)',
    offMsg: 'Auto-fill mark removed — will park at Prepared as usual',
  });
}

// Global one-shot default (settings.auto_fill_all): PREPARE chains into the fill
// for EVERY role, no per-card flag needed. Marker only — nothing launches now.
function syncAutoFillAllButton() {
  const btn = document.getElementById('btn-auto-fill-all');
  if (!btn) return;
  const on = settings.auto_fill_all === true;
  btn.classList.toggle('active', on);
  btn.textContent = on ? '⚡ One-shot: ALL' : '⚡ One-shot: off';
}

async function toggleAutoFillAll() {
  const next = !(settings.auto_fill_all === true);
  try {
    const res = await fetch('/api/autofill', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: next }),
    });
    if (!res.ok) { toast('Could not update one-shot setting', 3000); return; }
    toast(next
      ? '⚡ One-shot ON for all roles — every PREPARE chains straight into the fill (never submits)'
      : 'One-shot off — roles park at Prepared unless individually ⚡ flagged', 4000);
    await loadQueue();
  } catch {
    toast('One-shot update failed — check server logs', 4000);
  }
}

async function setThreshold() {
  const val = parseFloat(document.getElementById('threshold-input').value);
  if (isNaN(val) || val < 0 || val > 5) { toast('Enter a threshold between 0 and 5'); return; }
  const res  = await fetch('/api/threshold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: val }),
  });
  const data = await res.json();
  toast(`Threshold set to ${val} — ${data.flipped} role(s) queued for prepare.`);
  await loadQueue();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') {
      document.activeElement.blur();
      if (document.activeElement.id === 'search') {
        query = '';
        document.getElementById('search').value = '';
        renderAll();
      }
    }
    return;
  }

  switch (e.key) {
    case 'j': case 'ArrowDown':  e.preventDefault(); moveCursor(1);  break;
    case 'k': case 'ArrowUp':    e.preventDefault(); moveCursor(-1); break;
    case 'ArrowRight': case 'l': e.preventDefault(); moveLane(1);    break;
    case 'ArrowLeft':  case 'h': e.preventDefault(); moveLane(-1);   break;
    case 'Enter':                e.preventDefault(); openCurrentCard(); break;
    case ' ':                    e.preventDefault(); toggleCurrentCheck(); break;
    case 'Escape':               closeInbox(); break;
    case 'f':  if (activeId)                doFill();               break;
    case 's':  if (activeId)                doDecision('submitted'); break;
    case 'x':  if (activeId)                doDecision('skipped');  break;
    case 'r':  loadQueue(); break;
    case 'o':  openCurrentUrl(); break;
    case '/':  e.preventDefault(); document.getElementById('search').focus(); break;
  }
});

function toggleCurrentCheck() {
  const roles = getStageRoles(cursor.stageKey);
  const role  = roles[cursor.idx];
  if (!role) return;
  const checked = !checkedIds.has(role.id);
  toggleCheck(role.id, checked);
  // Update the checkbox in the card
  const chk = document.querySelector(`.card[data-id="${CSS.escape(role.id)}"] .card-checkbox`);
  if (chk) chk.checked = checked;
}

// ── Cursor management ─────────────────────────────────────────────────────────
// The cursor moves across the 4 interactive stage columns; the Done column is
// read-only tracker history and is not keyboard-navigable.

function getStageRoles(stageKey) {
  return stageMapFor(filterRoles(allRoles))[stageKey] || [];
}

function moveCursor(delta) {
  const roles = getStageRoles(cursor.stageKey);
  if (roles.length === 0) return;
  cursor.idx = Math.max(0, Math.min(roles.length - 1, cursor.idx + delta));
  syncCursorHighlight();
  scrollCursorIntoView();
}

function moveLane(delta) {
  const stageIdx = STAGE_NAV.indexOf(cursor.stageKey);
  const next     = STAGE_NAV[Math.max(0, Math.min(STAGE_NAV.length - 1, stageIdx + delta))];
  const roles    = getStageRoles(next);
  cursor = { stageKey: next, idx: Math.min(cursor.idx, Math.max(0, roles.length - 1)) };
  syncCursorHighlight();
  scrollCursorIntoView();
}

function syncCursorHighlight() {
  document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  const roles = getStageRoles(cursor.stageKey);
  if (!roles.length) return;
  const role = roles[cursor.idx];
  if (!role) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(role.id)}"]`);
  if (card) card.classList.add('selected');
}

function scrollCursorIntoView() {
  const roles = getStageRoles(cursor.stageKey);
  if (!roles.length) return;
  const role = roles[cursor.idx];
  if (!role) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(role.id)}"]`);
  card?.scrollIntoView({ block: 'nearest' });
}

function openCurrentCard() {
  const roles = getStageRoles(cursor.stageKey);
  const role  = roles[cursor.idx];
  if (role) openInbox(role.id);
}

function openCurrentUrl() {
  if (activeId) {
    const role = allRoles.find(r => r.id === activeId);
    if (role?.url) window.open(role.url, '_blank', 'noopener');
    return;
  }
  const roles = getStageRoles(cursor.stageKey);
  const role  = roles[cursor.idx];
  if (role?.url) window.open(role.url, '_blank', 'noopener');
}

function advanceCursor() {
  const roles = getStageRoles(cursor.stageKey);
  if (roles.length > 0) {
    cursor.idx = Math.min(cursor.idx, roles.length - 1);
    syncCursorHighlight();
    scrollCursorIntoView();
  } else {
    for (const sk of STAGE_NAV) {
      if (getStageRoles(sk).length > 0) {
        cursor = { stageKey: sk, idx: 0 };
        syncCursorHighlight();
        break;
      }
    }
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function setupEventListeners() {
  document.getElementById('btn-refresh').addEventListener('click', loadQueue);
  document.getElementById('btn-close-inbox').addEventListener('click', closeInbox);
  document.getElementById('btn-set-threshold').addEventListener('click', setThreshold);
  document.getElementById('threshold-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') setThreshold();
  });

  document.getElementById('btn-fill').addEventListener('click', () => doFill());
  document.getElementById('btn-submit').addEventListener('click', () => doDecision('submitted'));
  document.getElementById('btn-skip').addEventListener('click', () => doDecision('skipped'));
  document.getElementById('btn-reviewed').addEventListener('click', () => doDecision('reviewed'));
  document.getElementById('btn-deep-eval').addEventListener('click', toggleDeepEval);
  document.getElementById('btn-auto-fill').addEventListener('click', toggleAutoFill);
  document.getElementById('btn-auto-fill-all').addEventListener('click', toggleAutoFillAll);

  document.getElementById('btn-select-all').addEventListener('click', selectAll);
  document.getElementById('btn-clear-all').addEventListener('click', clearAll);
  document.getElementById('btn-start-run').addEventListener('click', startRun);
  document.getElementById('btn-close-activity').addEventListener('click', () => {
    document.getElementById('activity-panel').setAttribute('hidden', '');
  });

  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', () => {
    query = searchInput.value.toLowerCase().trim();
    loadQueue();
  });

  setupDragAndDrop();
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Non-blocking confirm, used for drag-triggered Mark Submitted (a real tracker
// write, so it gets one extra deliberate step). Deliberately NOT a native
// window.confirm() — that blocks the page (and would block any future
// Playwright verification of this flow); this stays open until the user acts.
// Renders into its own #toast-confirm element so an informational toast()
// firing meanwhile can never wipe a pending confirm.
function confirmToast(msg, onConfirm) {
  const el = document.getElementById('toast-confirm');
  el.innerHTML = `
    <span class="toast-msg">${esc(msg)}</span>
    <span class="toast-actions">
      <button type="button" class="btn-sm toast-confirm">Confirm</button>
      <button type="button" class="btn-sm btn-sm-outline toast-cancel">Cancel</button>
    </span>`;
  el.classList.add('show');

  const cleanup = () => {
    el.classList.remove('show');
    el.innerHTML = '';
  };
  el.querySelector('.toast-confirm').addEventListener('click', () => { cleanup(); onConfirm(); }, { once: true });
  el.querySelector('.toast-cancel').addEventListener('click', cleanup, { once: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreColorClass(score) {
  if (score == null) return '';
  if (score >= 4.2)  return 'score-high';
  if (score >= 3.8)  return 'score-mid';
  if (score >= 3.0)  return 'score-low';
  return 'score-very-low';
}
