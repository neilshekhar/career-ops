#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.
#
# NOTE: This script is Claude Code-specific. It uses claude -p with
# path-scoped tool permissions and --append-system-prompt-file flags that are
# not available in other CLIs. Multi-CLI support is out of scope for now.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
PAUSE_FILE="$BATCH_DIR/batch-runner.paused"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
RESUME_PAUSED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
SKIP_PDF=true
MODEL=""  # empty = let claude -p use the Claude Max default
RATE_LIMIT_SLEEP=300
BATCH_PAUSED=false
STATUS_ONLY=false
WATCH_MODE=false
LIMIT=0
ACTIVE_WORKER_PIDS=()
RUN_TEMP_DIR=""

# Return success for non-negative integer or decimal strings.
is_decimal_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

render_prompt_template() {
  local template_file="$1"
  local output_file="$2"
  local url="$3"
  local jd_file="$4"
  local report_num="$5"
  local date="$6"
  local id="$7"

  node - "$template_file" "$output_file" "$url" "$jd_file" "$report_num" "$date" "$id" <<'NODE'
const fs = require('node:fs');

const [templateFile, outputFile, url, jdFile, reportNum, date, id] = process.argv.slice(2);
const values = {
  URL: url,
  JD_FILE: jdFile,
  REPORT_NUM: reportNum,
  DATE: date,
  ID: id,
};
const template = fs.readFileSync(templateFile, 'utf8');
// URL/JD/report identify the assignment. DATE and ID remain supported but are
// optional so minimal test/alternate templates can rely on the runtime prompt.
for (const key of ['URL', 'JD_FILE', 'REPORT_NUM']) {
  if (!template.includes(`{{${key}}}`)) {
    throw new Error(`batch prompt template is missing required placeholder {{${key}}}`);
  }
}
const rendered = template.replace(
  /\{\{(URL|JD_FILE|REPORT_NUM|DATE|ID)\}\}/g,
  (_, key) => values[key],
);
fs.writeFileSync(outputFile, rendered, 'utf8');
NODE
  chmod 600 "$output_file"
}

permission_path_rule() {
  local tool="$1"
  local path_pattern="$2"
  if [[ "$path_pattern" != /* ]]; then
    path_pattern="$PROJECT_DIR/$path_pattern"
  fi
  # Claude Code permission rules use a double-leading slash for absolute paths.
  printf '%s(/%s)' "$tool" "$path_pattern"
}

permission_edit_rule() {
  permission_path_rule Edit "$1"
}

permission_write_rule() {
  permission_path_rule Write "$1"
}

permission_read_rule() {
  permission_path_rule Read "$1"
}

verify_worker_artifacts() {
  local id="$1"
  local url="$2"
  local report_num="$3"
  local date="$4"
  local skip_pdf="$5"

  node - "$REPORTS_DIR" "$TRACKER_DIR" "$PROJECT_DIR" \
    "$id" "$url" "$report_num" "$date" "$skip_pdf" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const [
  reportsDir, trackerDir, projectDir,
  id, url, reportNum, date, skipPdfRaw,
] = process.argv.slice(2);
const skipPdf = skipPdfRaw === 'true';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function regularNonemptyFile(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
  invariant(stat.isFile() && stat.size > 0, `${label} is empty or not a regular file: ${file}`);
}

try {
  const trackerPath = path.join(trackerDir, `${id}.tsv`);
  regularNonemptyFile(trackerPath, 'assigned tracker addition');
  const trackerText = fs.readFileSync(trackerPath, 'utf8').replace(/\r/g, '');
  const trackerLines = trackerText.split('\n').filter((line) => line.length > 0);
  invariant(trackerLines.length === 1, 'assigned tracker addition must contain exactly one line');
  const fields = trackerLines[0].split('\t');
  invariant(fields.length >= 9, 'assigned tracker addition must contain at least 9 TSV columns');
  invariant(/^[0-9]+$/.test(fields[0]), 'tracker number must be numeric');
  invariant(fields[1] === date, `tracker date must equal assigned date ${date}`);
  invariant(fields[2].trim() !== '' && fields[3].trim() !== '', 'tracker company and role are required');
  invariant(fields[4] === 'Evaluated', 'batch tracker status must be exactly Evaluated');
  invariant(fields[8].trim() !== '', 'tracker notes are required');

  const reportLink = fields[7].match(/^\[([0-9]+)\]\((reports\/([^/]+\.md))\)$/);
  invariant(reportLink, 'tracker report field must be one root-relative markdown link');
  invariant(reportLink[1] === reportNum, `tracker report number must equal assigned report ${reportNum}`);
  const reportBasename = reportLink[3];
  const expectedReportPattern = new RegExp(
    `^${reportNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[^/]+-${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`,
  );
  invariant(expectedReportPattern.test(reportBasename), 'tracker report filename does not match the assigned report/date');

  const reportPath = path.join(reportsDir, reportBasename);
  regularNonemptyFile(reportPath, 'assigned report');
  const report = fs.readFileSync(reportPath, 'utf8').replace(/\r/g, '');
  invariant(report.split('\n').includes(`**URL:** ${url}`), 'report URL does not exactly match the assigned URL');
  invariant(report.split('\n').includes(`**Batch ID:** ${id}`), 'report Batch ID does not match the assigned item');
  for (const section of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    invariant(
      new RegExp(`^## ${section}\\)`, 'm').test(report),
      `report is missing required section ${section}`,
    );
  }

  const summaryBlocks = [...report.matchAll(
    /^## Machine Summary[ \t]*\n+[ \t]*```yaml[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm,
  )];
  invariant(summaryBlocks.length === 1, 'report must contain exactly one fenced YAML Machine Summary');
  const summary = yaml.load(summaryBlocks[0][1], { schema: yaml.JSON_SCHEMA });
  invariant(summary && typeof summary === 'object' && !Array.isArray(summary), 'Machine Summary must be a YAML mapping');
  const requiredKeys = [
    'company', 'role', 'score', 'legitimacy_tier', 'archetype',
    'final_decision', 'hard_stops', 'soft_gaps', 'top_strengths',
    'risk_level', 'confidence', 'next_action', 'via',
    'company_confidential', 'advertised_comp',
  ];
  for (const key of requiredKeys) {
    invariant(Object.prototype.hasOwnProperty.call(summary, key), `Machine Summary is missing ${key}`);
  }
  invariant(typeof summary.company === 'string' && summary.company.trim() !== '', 'Machine Summary company is required');
  invariant(typeof summary.role === 'string' && summary.role.trim() !== '', 'Machine Summary role is required');
  invariant(summary.company === fields[2], 'Machine Summary company must match the tracker company');
  invariant(summary.role === fields[3], 'Machine Summary role must match the tracker role');
  invariant(typeof summary.score === 'number' && Number.isFinite(summary.score), 'Machine Summary score must be numeric');
  invariant(summary.score >= 0 && summary.score <= 5, 'Machine Summary score must be between 0 and 5');
  for (const key of ['hard_stops', 'soft_gaps', 'top_strengths']) {
    invariant(Array.isArray(summary[key]), `Machine Summary ${key} must be an array`);
  }
  invariant(typeof summary.company_confidential === 'boolean', 'Machine Summary company_confidential must be boolean');
  invariant(summary.via === null || typeof summary.via === 'string', 'Machine Summary via must be a string or null');
  invariant(
    summary.advertised_comp === null || typeof summary.advertised_comp === 'string',
    'Machine Summary advertised_comp must be a string or null',
  );

  const trackerScore = fields[5].match(/^([0-9]+(?:\.[0-9]+)?)\/5$/);
  invariant(trackerScore, 'completed batch tracker score must be numeric and end in /5');
  invariant(
    Math.abs(Number(trackerScore[1]) - summary.score) < 1e-9,
    'Machine Summary score must match the tracker score',
  );
  const reportScore = report.match(/^\*\*Score:\*\*[ \t]*([0-9]+(?:\.[0-9]+)?)\/5[ \t]*$/m);
  invariant(reportScore, 'report header must contain a numeric Score');
  invariant(
    Math.abs(Number(reportScore[1]) - summary.score) < 1e-9,
    'Machine Summary score must match the report header score',
  );

  const pdfHeader = report.match(/^\*\*PDF:\*\*[ \t]*(.+?)[ \t]*$/m);
  invariant(pdfHeader, 'report header must contain PDF metadata');
  const pdfCell = fields[6];
  let draftThreshold = 3.0;
  const profilePath = path.join(projectDir, 'config', 'profile.yml');
  if (fs.existsSync(profilePath)) {
    const profile = yaml.load(fs.readFileSync(profilePath, 'utf8'), { schema: yaml.JSON_SCHEMA });
    const configuredThreshold = profile?.auto_pdf_score_threshold;
    if (configuredThreshold !== undefined && configuredThreshold !== null && configuredThreshold !== '') {
      draftThreshold = Number(configuredThreshold);
      invariant(
        Number.isFinite(draftThreshold) && draftThreshold >= 0,
        'config/profile.yml auto_pdf_score_threshold must be a non-negative number',
      );
    }
  }
  const draftPdfRequired = !skipPdf && summary.score >= draftThreshold;
  if (!draftPdfRequired) {
    invariant(pdfCell === '❌', 'evaluation-only tracker PDF marker must be ❌');
    invariant(
      /^not generated\b/i.test(pdfHeader[1]),
      'report must say the PDF was not generated when tracker PDF is ❌',
    );
  } else {
    invariant(
      pdfCell === '✅',
      `draft-PDF tracker marker must be ✅ when score ${summary.score} meets threshold ${draftThreshold}`,
    );
    const pdfRelative = pdfHeader[1];
    const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    invariant(
      new RegExp(`^output/cv-candidate-[^/]+-${escapedDate}\\.pdf$`).test(pdfRelative)
        && !pdfRelative.includes('..'),
      'draft PDF metadata must be its assigned dated output/cv-candidate-*.pdf path',
    );
    const outputRoot = path.resolve(projectDir, 'output');
    const pdfPath = path.resolve(projectDir, pdfRelative);
    invariant(
      pdfPath.startsWith(`${outputRoot}${path.sep}`),
      'draft PDF path escapes the project output directory',
    );
    regularNonemptyFile(pdfPath, 'declared draft PDF');
    const header = Buffer.alloc(5);
    const fd = fs.openSync(pdfPath, 'r');
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    invariant(header.toString('ascii') === '%PDF-', 'declared draft PDF does not have a PDF header');
    const htmlPath = pdfPath.replace(/\.pdf$/i, '.html');
    regularNonemptyFile(htmlPath, 'declared draft PDF source HTML');
  }

  process.stdout.write(String(summary.score));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
NODE
}

quarantine_tracker_addition() {
  local id="$1"
  local report_num="$2"
  local tracker_file="$TRACKER_DIR/${id}.tsv"
  if [[ -f "$tracker_file" ]]; then
    mv "$tracker_file" "$LOGS_DIR/${report_num}-${id}.tracker.failed.tsv"
  fi
}

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via claude -p workers
Uses your default Claude model (Claude Max subscription).

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --resume-paused      Resume offers paused by a Claude session/rate limit
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Max number of offers to process in this run
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        After evaluation, mark lower-scoring batch items skipped
                       (report + Evaluated tracker row remain; default: 0 = off)
  --skip-pdf           Skip PDF generation (default; keeps batch evaluation-only)
  --draft-pdf          Generate non-release batch PDF drafts. Requires an explicit
                       model ID; an optional profile allowlist can restrict it.
  --rate-limit-sleep N Seconds to wait before retrying a rate-limited worker
                       (default: 300)
  --model NAME         Claude model passed to `claude -p --model`. Batch scores are
                       provisional triage signals: cheaper models save tokens but
                       may mis-rank roles. Final application assets never release
                       from this flow.
  --status             Show batch progress and a per-job table, then exit
  --watch              Live-refresh progress until the run completes
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --resume-paused) RESUME_PAUSED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --skip-pdf) SKIP_PDF=true; shift ;;
    --draft-pdf) SKIP_PDF=false; shift ;;
    --rate-limit-sleep)
      [[ $# -ge 2 ]] || { echo "ERROR: --rate-limit-sleep requires an argument"; exit 1; }
      RATE_LIMIT_SLEEP="$2"
      shift 2
      ;;
    --model) MODEL="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --watch) WATCH_MODE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! [[ "$RATE_LIMIT_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --rate-limit-sleep must be a non-negative integer (seconds)."
  exit 1
fi

if ! is_decimal_number "$MIN_SCORE"; then
  echo "ERROR: --min-score must be a non-negative number."
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit must be a non-negative integer."
  exit 1
fi

if [[ "$SKIP_PDF" == "false" ]]; then
  if [[ -z "$MODEL" ]]; then
    echo "ERROR: --draft-pdf requires an explicit --model so the batch asset floor can be enforced."
    exit 1
  fi
  if ! node "$PROJECT_DIR/generation-provenance.mjs" check-batch-model --model "$MODEL"; then
    echo "ERROR: Batch PDF generation is blocked by application_quality.allowed_batch_asset_models."
    exit 1
  fi
fi

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

initialize_run_temp_dir() {
  RUN_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/career-ops-batch-${MAIN_PID}.XXXXXX")
  chmod 700 "$RUN_TEMP_DIR"
}

cleanup_run_temp_dir() {
  if [[ -z "$RUN_TEMP_DIR" || ! -d "$RUN_TEMP_DIR" ]]; then
    return
  fi
  local temp_file
  for temp_file in "$RUN_TEMP_DIR"/batch-jd-* "$RUN_TEMP_DIR"/batch-prompt-*; do
    if [[ -f "$temp_file" ]]; then
      rm -f -- "$temp_file"
    fi
  done
  rmdir "$RUN_TEMP_DIR" 2>/dev/null || true
  RUN_TEMP_DIR=""
}

cleanup_main() {
  local exit_code=$?
  # Prevent recursive traps while terminating any still-running worker
  # subshells. Their TERM/EXIT traps remove the per-offer JD and prompt files.
  trap - EXIT HUP INT TERM
  local children child_pid
  children="${ACTIVE_WORKER_PIDS[*]:-} $(jobs -pr 2>/dev/null || true)"
  for child_pid in $children; do
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  for child_pid in $children; do
    wait "$child_pid" 2>/dev/null || true
  done
  cleanup_run_temp_dir
  release_state_lock
  release_lock
  exit "$exit_code"
}

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

# Status/watch mode only needs prior batch state, not worker prerequisites.
check_status_prerequisites() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    exit 0
  fi
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  if [[ "${STATE_LOCK_DISABLED:-0}" -eq 1 ]]; then
    return 0
  fi

  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        STATE_LOCK_OWNED=1
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      if (( PARALLEL <= 1 )); then
        echo "WARN: State lock creation failed. Falling back to lock-free operation (single-worker mode)." >&2
        STATE_LOCK_DISABLED=1
        STATE_LOCK_OWNED=0
        return 0
      fi
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  if [[ "${STATE_LOCK_OWNED:-0}" -ne 1 ]]; then
    return
  fi
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
  STATE_LOCK_OWNED=0
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      num=$((10#$num)) # Remove leading zeros for arithmetic
      if (( num > max_num )); then
        max_num=$num
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

is_rate_limit_log() {
  local log_file="$1"
  grep -Eiq '(rate limit|rate_limit|too many requests|429|quota exceeded|try again later|temporarily unavailable)' "$log_file"
}

is_session_limit_log() {
  local log_file="$1"
  grep -Eiq '(session limit|resets [0-9:]+[ap]m|usage limit|limit[[:space:]]+reached)' "$log_file"
}

mark_paused_rate_limit() {
  local id="$1" url="$2" started_at="$3" report_num="$4" retries="$5" log_file="$6"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local error_msg
  error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "session/rate limit reached")
  update_state "$id" "$url" "paused_rate_limit" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
  printf '%s\t%s\t%s\n' "$id" "$report_num" "$error_msg" > "$PAUSE_FILE"
  BATCH_PAUSED=true
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer in its own subshell so per-worker traps and permission
# variables cannot leak into the orchestrator or sibling workers.
process_offer() (
  local id="$1" url="$2" source="$3" notes="$4"
  local jd_file=""
  local resolved_prompt=""
  local worker_command_pid=""

  cleanup_worker_temps() {
    if [[ -n "$worker_command_pid" ]] && kill -0 "$worker_command_pid" 2>/dev/null; then
      kill -TERM "$worker_command_pid" 2>/dev/null || true
      wait "$worker_command_pid" 2>/dev/null || true
    fi
    if [[ -n "$resolved_prompt" ]]; then
      rm -f -- "$resolved_prompt"
    fi
    if [[ -n "$jd_file" ]]; then
      rm -f -- "$jd_file"
    fi
  }
  # EXIT covers success, ordinary failure, early return, and the signal exits.
  # Signal traps deliberately terminate so an interrupted worker cannot resume
  # after its temporary instruction/JD files have been removed.
  trap cleanup_worker_temps EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  umask 077

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  local date
  date=$(date +%Y-%m-%d)
  # Use mktemp instead of a predictable /tmp path: a fixed name like
  # /tmp/batch-jd-${id}.txt is guessable, so an attacker on a shared machine
  # could pre-create it as a symlink and redirect or clobber the write.
  if [[ -z "$RUN_TEMP_DIR" || ! -d "$RUN_TEMP_DIR" ]]; then
    echo "ERROR: Batch run temp directory is unavailable."
    return 1
  fi
  jd_file="$(mktemp "$RUN_TEMP_DIR/batch-jd-${id}.XXXXXX")"
  resolved_prompt="$(mktemp "$RUN_TEMP_DIR/batch-prompt-${id}.XXXXXX")"

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  # Build the prompt with placeholders replaced
  local prompt
  if [[ "$SKIP_PDF" == "true" ]]; then
    prompt="Procesa esta oferta de empleo. Ejecuta el pipeline: evaluación A-G + report .md + tracker line. NO generes PDF; en el tracker escribe ❌ en la columna PDF y en el JSON final establece \"pdf\": null."
    echo "    ⏭️  evaluation-only batch — skipping PDF generation for #$id ($url)"
  else
    prompt="Procesa esta oferta de empleo. Ejecuta evaluación A-G + report .md + PDF BORRADOR + tracker line. El PDF es batch-draft, no es elegible para PREPARE ni para enviar; no escribas generation_provenance."
  fi
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  # One-pass callback replacement preserves every URL byte (including &, \,
  # delimiter-like text, and strings that resemble another placeholder).
  render_prompt_template \
    "$PROMPT_FILE" "$resolved_prompt" "$url" "$jd_file" "$report_num" "$date" "$id"

  # Inject user-layer personalization into the temporary worker prompt.
  # The resolved prompt is gitignored runtime state, so user profile data stays
  # out of the system layer while batch scoring matches interactive scoring.
  for context_file in "$PROJECT_DIR/modes/_profile.md" "$PROJECT_DIR/config/profile.yml" "$PROJECT_DIR/modes/_custom.md"; do
    if [[ -f "$context_file" ]]; then
      {
        printf '\n\n---\n\n'
        printf '## Runtime personalization: %s\n\n' "${context_file#$PROJECT_DIR/}"
        sed 's/^/    /' "$context_file"
        printf '\n'
      } >> "$resolved_prompt"
    fi
  done

  # Launch claude -p worker.
  # Model defaults to the Claude Max subscription default unless --model was
  # passed. Building the command in an array keeps quoting safe regardless.
  # --strict-mcp-config (with no --mcp-config) starts workers with no MCP
  # servers: they only evaluate offers and need none. Without it each parallel
  # worker inherits the parent session's MCP (e.g. Playwright) and they deadlock
  # fighting over the single shared browser when --parallel > 1 (issue #506).
  #
  # `dontAsk` denies anything not explicitly pre-approved in headless mode.
  # Edit permissions are restricted to this worker's report number and exact
  # tracker file. Draft mode adds only the dated draft HTML path and the one
  # renderer command; evaluation-only workers receive no Bash tool at all.
  local worker_tools="Read,Edit,Write,WebFetch,WebSearch"
  local allowed_tools
  allowed_tools="WebFetch,WebSearch"
  local readable_path
  for readable_path in \
    "$jd_file" \
    "$PROJECT_DIR/cv.md" \
    "$PROJECT_DIR/llms.txt" \
    "$PROJECT_DIR/article-digest.md" \
    "$PROJECT_DIR/i18n.ts" \
    "$PROJECT_DIR/config/profile.yml" \
    "$PROJECT_DIR/modes/_profile.md" \
    "$PROJECT_DIR/modes/_custom.md" \
    "$PROJECT_DIR/data/applications.md" \
    "$PROJECT_DIR/data/scan-history.tsv"; do
    allowed_tools+=",$(permission_read_rule "$readable_path")"
  done
  allowed_tools+=",$(permission_read_rule "$REPORTS_DIR/${report_num}-*-${date}.md")"
  allowed_tools+=",$(permission_read_rule "$TRACKER_DIR/${id}.tsv")"
  allowed_tools+=",$(permission_edit_rule "$REPORTS_DIR/${report_num}-*-${date}.md")"
  allowed_tools+=",$(permission_edit_rule "$TRACKER_DIR/${id}.tsv")"
  allowed_tools+=",$(permission_write_rule "$REPORTS_DIR/${report_num}-*-${date}.md")"
  allowed_tools+=",$(permission_write_rule "$TRACKER_DIR/${id}.tsv")"
  if [[ "$SKIP_PDF" == "false" ]]; then
    worker_tools+=",Bash"
    allowed_tools+=",$(permission_read_rule "$PROJECT_DIR/templates/cv-template.html")"
    allowed_tools+=",$(permission_read_rule "$PROJECT_DIR/generate-pdf.mjs")"
    allowed_tools+=",$(permission_read_rule "$PROJECT_DIR/output/cv-candidate-*-${date}.html")"
    allowed_tools+=",$(permission_read_rule "$PROJECT_DIR/output/cv-candidate-*-${date}.pdf")"
    allowed_tools+=",$(permission_edit_rule "$PROJECT_DIR/output/cv-candidate-*-${date}.html")"
    allowed_tools+=",$(permission_write_rule "$PROJECT_DIR/output/cv-candidate-*-${date}.html")"
    allowed_tools+=",Bash(node generate-pdf.mjs:*)"
  fi
  local -a claude_args=(-p --safe-mode --no-session-persistence --permission-mode dontAsk --tools "$worker_tools" --allowedTools "$allowed_tools" --strict-mcp-config)
  if [[ -n "$MODEL" ]]; then
    claude_args+=(--model "$MODEL")
  fi
  claude_args+=(--append-system-prompt-file "$resolved_prompt" "$prompt")

  local exit_code=0
  local terminal_failure_recorded=false
  local shim_retries=0
  local max_shim_retries=4
  # All worker instructions and allowed Bash command paths are rooted here,
  # even when the caller invokes this script from another working directory.
  cd "$PROJECT_DIR"
  while true; do
    exit_code=0
    claude "${claude_args[@]}" > "$log_file" 2>&1 &
    worker_command_pid=$!
    wait "$worker_command_pid" 2>/dev/null || exit_code=$?
    worker_command_pid=""

    if [[ $exit_code -eq 0 ]]; then
      break
    fi

    # Check for Claude Code npm shim swap (exit code 127 + command not found)
    if [[ $exit_code -eq 127 ]] && grep -qE "(claude: command not found|claude:.*not found|cannot find.*claude)" "$log_file" && (( shim_retries < max_shim_retries )); then
      shim_retries=$((shim_retries + 1))
      echo "    ⏳ Claude command not found (shim swap detected). Retrying in 30s (attempt $shim_retries/$max_shim_retries)..."
      sleep 30
      continue
    fi

    if is_session_limit_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    ⏸️  Session/rate limit reached; pausing batch without consuming retry budget."
      terminal_failure_recorded=true
      break
    fi

    if is_rate_limit_log "$log_file" && (( retries < MAX_RETRIES )); then
      if (( RATE_LIMIT_SLEEP <= 0 )); then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Rate limited and --rate-limit-sleep is 0; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      retries=$((retries + 1))
      local retry_completed_at
      retry_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      update_state "$id" "$url" "rate_limited" "$started_at" "$retry_completed_at" "$report_num" "-" "rate-limit; retrying after ${RATE_LIMIT_SLEEP}s" "$retries"
      echo "    ⏳ Rate limited (attempt $retries/$MAX_RETRIES). Waiting ${RATE_LIMIT_SLEEP}s before retry..."
      sleep "$RATE_LIMIT_SLEEP"
      continue
    fi

    break
  done

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    # Treat stdout as an untrusted claim. Completion is authorized only by the
    # assigned durable report/tracker/Machine Summary (and declared draft PDF).
    local score="-"
    local verification_output=""
    if verification_output=$(verify_worker_artifacts \
      "$id" "$url" "$report_num" "$date" "$SKIP_PDF" 2>&1); then
      score="$verification_output"
    else
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      local verification_error
      verification_error=$(printf '%s' "$verification_output" | tr '\t\r\n' ' ' | cut -c1-200)
      quarantine_tracker_addition "$id" "$report_num"
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" \
        "artifact-verification: ${verification_error:-unknown verification failure}" "$retries"
      echo "    ❌ Failed artifact verification (attempt $retries): ${verification_error:-unknown verification failure}"
      return 0
    fi

    # Optional triage-state gate. The worker has already persisted the canonical
    # A-G report and Evaluated tracker row; this only prevents low-scoring batch
    # items from being treated as completed candidates for later batch actions.
    if is_decimal_number "$score" && awk -v min="$MIN_SCORE" 'BEGIN{exit !(min > 0)}'; then
      if awk -v score="$score" -v min="$MIN_SCORE" 'BEGIN{exit !(score < min)}'; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Triage-skipped (score: $score < min-score: $MIN_SCORE; report/tracker preserved)"
        return 0
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  elif [[ "$terminal_failure_recorded" == "false" ]]; then
    quarantine_tracker_addition "$id" "$report_num"
    if (( retries < MAX_RETRIES )); then
      retries=$((retries + 1))
    fi
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  else
    quarantine_tracker_addition "$id" "$report_num"
  fi
)

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Reconciling pipeline.md ==="
  node "$PROJECT_DIR/reconcile-pipeline.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  # A failed integrity check is a failed batch run. Do not print a warning and
  # continue with a misleading process exit code of zero.
  node "$PROJECT_DIR/verify-pipeline.mjs"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 skipped=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      skipped) skipped=$((skipped + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Skipped: $skipped | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

print_status_table() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    return
  fi

  local total=0 completed=0 processing=0 failed=0 pending=0 skipped=0 rate_limited=0 paused_rate_limit=0
  local score_sum=0 score_count=0

  # Read first line to skip header
  local header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    total=$((total + 1))
    case "$sstatus" in
      completed)
        completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      processing) processing=$((processing + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      rate_limited) rate_limited=$((rate_limited + 1)) ;;
      paused_rate_limit) paused_rate_limit=$((paused_rate_limit + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "=== Batch Progress ==="
  echo "Total: $total | Completed: $completed | Processing: $processing | Failed: $failed | Pending: $pending | Skipped: $skipped | Rate Limited: $rate_limited | Paused: $paused_rate_limit"
  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
  echo ""

  # Format the per-job table:
  # Columns: ID, Status, Report, Score, Target (URL or Error Message)
  printf "%-4s | %-17s | %-6s | %-5s | %-40s\n" "ID" "Status" "Report" "Score" "URL / Error"
  printf "%-4s+%-19s+%-8s+%-7s+%-42s\n" "----" "-------------------" "--------" "-------" "------------------------------------------"

  header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    local target="$surl"
    if [[ "$sstatus" == "failed" && -n "$serror" && "$serror" != "-" ]]; then
      target="Error: $serror"
    fi
    # Trim target to fit nicely (e.g. 50 chars)
    if (( ${#target} > 50 )); then
      target="${target:0:47}..."
    fi
    printf "%-4s | %-17s | %-6s | %-5s | %-50s\n" "$sid" "$sstatus" "$sreport" "$sscore" "$target"
  done < "$STATE_FILE"
}

watch_status() {
  local active_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    active_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    echo "Watching batch-runner (PID $active_pid)... Press Ctrl+C to stop."
    while kill -0 "$active_pid" 2>/dev/null; do
      clear || printf "\033[c"
      echo "=== Watching Batch Progress (PID $active_pid) ==="
      print_status_table
      sleep 2
    done
    echo ""
    echo "=== Batch runner process (PID $active_pid) has finished ==="
  else
    echo "No active batch-runner detected."
  fi

  echo "Showing final status:"
  print_status_table

  # Chain verify-pipeline.mjs
  if [[ -f "$PROJECT_DIR/verify-pipeline.mjs" ]]; then
    echo ""
    echo "=== Running pipeline verification ==="
    node "$PROJECT_DIR/verify-pipeline.mjs"
  fi
}

# Main
main() {
  if [[ "$STATUS_ONLY" == "true" ]]; then
    check_status_prerequisites
    print_status_table
    exit 0
  fi

  if [[ "$WATCH_MODE" == "true" ]]; then
    check_status_prerequisites
    watch_status
    exit 0
  fi

  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
    trap cleanup_main EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    initialize_run_temp_dir
    rm -f "$PAUSE_FILE"
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  if (( LIMIT > 0 )); then
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Limit: $LIMIT"
  else
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  fi
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RESUME_PAUSED" == "true" ]]; then
      if [[ "$status" != "paused_rate_limit" ]]; then
        continue
      fi
    elif [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip terminal offers
      if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
        continue
      fi
      # Paused rate-limit offers resume explicitly with --resume-paused.
      if [[ "$status" == "paused_rate_limit" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    if (( LIMIT > 0 )) && (( ${#pending_ids[@]} >= LIMIT )); then
      break
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      # Keep even the single worker as a managed child so TERM sent directly to
      # the orchestrator can be forwarded and its temp-file traps can run.
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      local worker_pid=$!
      ACTIVE_WORKER_PIDS=("$worker_pid")
      wait "$worker_pid" 2>/dev/null || true
      ACTIVE_WORKER_PIDS=()
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Resume later with --resume-paused. ==="
        break
      fi
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
        break
      fi

      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        ACTIVE_WORKER_PIDS=("${pids[@]}")
        if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
          echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
          break
        fi
        sleep 1
      done

      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        break
      fi

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      ACTIVE_WORKER_PIDS=("${pids[@]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
    ACTIVE_WORKER_PIDS=()
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary

  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
