// Offline behavioral coverage for the no-JD retry lifecycle. No queue files,
// user data, Supabase credentials, or network calls are touched.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nQueue — no-JD lifecycle');

try {
  const sweep = await import(pathToFileURL(join(ROOT, 'queue-sweep.mjs')).href);
  const ingest = await import(pathToFileURL(join(ROOT, 'queue-ingest.mjs')).href);
  const {
    assessJdContent,
    hasSubstantiveJd,
    jdFetchAttemptVerdict,
    shouldAttemptJdFetch,
    recordJdFetchFailure,
    recordJdFetchSuccess,
    sweepQueue,
  } = sweep;

  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
  const realJd = [
    'About the role',
    'You will build and operate reliable data pipelines, partner with analysts,',
    'improve observability, and own production delivery across the platform.',
    'Responsibilities include data modelling, incident response, testing, and documentation.',
    'Requirements: professional SQL and Python experience, communication skills,',
    'and experience working with cloud data warehouses in cross-functional teams.',
  ].join(' ');

  // A long page is not necessarily a JD. This exact kind of repeated portal
  // chrome previously cleared the 200-character floor and vanished from the
  // sweep's open/closed lists as though it were substantive.
  const navShell = (
    'Careers Search jobs Job alerts Sign in Privacy Terms Cookie preferences Contact us '
  ).repeat(6);
  const navAssessment = assessJdContent(navShell);
  if (navShell.length > 200 && !navAssessment.substantive &&
      ['navigation-shell', 'repetitive-shell'].includes(navAssessment.code) &&
      ingest.descriptionNeedsRecovery(navShell)) {
    pass('long navigation/cookie boilerplate fails the shared ingest+sweep JD gate');
  } else {
    fail(`navigation shell assessment wrong: ${JSON.stringify(navAssessment)}`);
  }

  const listing = `42 jobs found. Search for jobs page is loaded. ${'Browse teams and locations. '.repeat(20)}`;
  const expired = `This job is no longer available. ${'Return to careers and search current vacancies. '.repeat(15)}`;
  const challenge = `Just a moment. Enable JavaScript and cookies to continue. ${'Security verification. '.repeat(20)}`;
  if (!hasSubstantiveJd({ jd_text: listing }) &&
      !hasSubstantiveJd({ jd_text: expired }) &&
      !hasSubstantiveJd({ jd_text: challenge })) {
    pass('listing, expired, and anti-bot pages cannot satisfy the substantive-JD gate');
  } else {
    fail('a listing, expired, or anti-bot page was accepted as a substantive JD');
  }

  if (hasSubstantiveJd({ jd_text: realJd }) && !ingest.descriptionNeedsRecovery(realJd)) {
    pass('a responsibilities+requirements JD passes both ingest and sweep checks');
  } else {
    fail('a real responsibilities+requirements JD was rejected');
  }
  if (hasSubstantiveJd({ jd_text: `${navShell} ${realJd}` })) {
    pass('portal chrome around a real JD does not trigger a shell false positive');
  } else {
    fail('portal chrome caused a real JD to be rejected');
  }
  if (hasSubstantiveJd({ jd_text: `${realJd} You will build application closed-loop monitoring and alerting.` })) {
    pass('technical closed-loop wording is not misread as an applications-closed banner');
  } else {
    fail('technical closed-loop wording caused a false expired-page rejection');
  }

  // Guard multilingual content against an English-shell-heuristic regression.
  const japaneseJd = (
    '仕事内容 データパイプラインの設計と運用、品質改善、監視、関係部門との連携を担当します。' +
    '応募資格 SQLとPythonの実務経験、クラウド基盤の知識、明確なコミュニケーション能力が必須です。'
  ).repeat(3);
  if (hasSubstantiveJd({ jd_text: japaneseJd })) {
    pass('substantive Japanese JD text is not rejected as low-diversity boilerplate');
  } else {
    fail('substantive Japanese JD text was rejected');
  }

  // Executable fetch decision: deterministic is manual-only; transient gets
  // exactly the remaining attempts and stops at either cap.
  const initial = { status: 'new', flags: [] };
  const deterministic = {
    status: 'new',
    jd_fetch: { class: 'deterministic', attempts: 1, first_failed_at: day(0) },
  };
  const transient = {
    status: 'new',
    jd_fetch: { class: 'transient', attempts: 2, first_failed_at: day(0) },
  };
  const capped = {
    status: 'new',
    jd_fetch: { class: 'transient', attempts: 3, first_failed_at: day(0) },
  };
  const aged = {
    status: 'new',
    jd_fetch: { class: 'transient', attempts: 1, first_failed_at: day(0) },
  };
  if (shouldAttemptJdFetch(initial, { now: day(1) }) &&
      !shouldAttemptJdFetch(deterministic, { now: day(1) }) &&
      shouldAttemptJdFetch(transient, { now: day(2) }) &&
      !shouldAttemptJdFetch(capped, { now: day(2) }) &&
      !shouldAttemptJdFetch(aged, { now: day(14) })) {
    pass('automatic-fetch decision enforces deterministic/manual and transient attempt+age caps');
  } else {
    fail('automatic-fetch decision does not enforce the retry policy');
  }
  if (jdFetchAttemptVerdict(deterministic, { now: day(1) }).code === 'manual-action-required' &&
      jdFetchAttemptVerdict(capped, { now: day(2) }).code === 'attempt-cap-reached' &&
      jdFetchAttemptVerdict(aged, { now: day(14) }).code === 'age-cap-reached') {
    pass('retry decisions expose stable reason codes for the queue workflow');
  } else {
    fail('retry decision reason codes are wrong');
  }

  // Recovery is checked and preserves unrelated operational flags.
  const recovered = { status: 'new', flags: ['login-required'] };
  recordJdFetchFailure(recovered, { reason: 'timeout', now: day(0) });
  recovered.jd_text = realJd;
  const recoveredResult = recordJdFetchSuccess(recovered);
  if (recoveredResult.ok && recoveredResult.changed &&
      !('jd_fetch' in recovered) &&
      !recovered.flags.includes('no-jd') &&
      recovered.flags.includes('login-required')) {
    pass('successful JD recovery clears jd_fetch/no-jd and preserves unrelated flags');
  } else {
    fail(`successful recovery transition wrong: ${JSON.stringify({ recoveredResult, recovered })}`);
  }

  const fakeRecovery = { status: 'new', flags: [] };
  recordJdFetchFailure(fakeRecovery, { reason: 'timeout', now: day(0) });
  fakeRecovery.jd_text = navShell;
  const fakeResult = recordJdFetchSuccess(fakeRecovery);
  if (!fakeResult.ok && fakeRecovery.jd_fetch && fakeRecovery.flags.includes('no-jd')) {
    pass('shell content cannot clear active no-jd failure markers');
  } else {
    fail('shell content incorrectly cleared no-jd failure markers');
  }

  // The normal end-of-run sweep also repairs markers after a candidate-pasted
  // JD, so recovery does not depend solely on remembering a separate command.
  const pasted = { id: 'pasted', status: 'new', company: 'A', title: 'B', flags: [] };
  recordJdFetchFailure(pasted, { reason: 'timeout', now: day(0) });
  pasted.jd_text = realJd;
  const swept = sweepQueue({ roles: [pasted] }, { now: day(2) });
  if (swept.recovered.length === 1 && swept.open.length === 0 && swept.closed.length === 0 &&
      !pasted.flags.includes('no-jd') && !('jd_fetch' in pasted)) {
    pass('end-of-run sweep clears recovered no-jd markers without closing the role');
  } else {
    fail(`sweep recovery behavior wrong: ${JSON.stringify({ swept, pasted })}`);
  }

  // Supabase currently has no atomic seen_urls -> active_roles revive
  // transaction. Keep exhausted cloud roles active/non-retryable rather than
  // turning an intended reversible closure into a one-way migration.
  const cloudExhausted = {
    id: 'cloud-exhausted',
    status: 'new',
    company: 'Cloud Co',
    title: 'Analyst',
    flags: ['no-jd'],
    jd_fetch: { class: 'transient', attempts: 3, first_failed_at: day(0) },
  };
  const cloudSweep = sweepQueue({ roles: [cloudExhausted] }, { now: day(2), allowClosure: false });
  if (cloudExhausted.status === 'new' && cloudSweep.closed.length === 0 &&
      cloudSweep.deferred.length === 1 && cloudSweep.open[0]?.closure_deferred === true &&
      !shouldAttemptJdFetch(cloudExhausted, { now: day(2) })) {
    pass('cloud sweep defers irreversible closure while keeping retry caps enforced');
  } else {
    fail(`cloud closure deferral wrong: ${JSON.stringify({ cloudSweep, cloudExhausted })}`);
  }

  // Exercise backend selection at the CLI boundary as well. With Supabase
  // explicitly selected but unconfigured, loadQueue uses the isolated shadow;
  // a deferred-only sweep must not try to save or mutate that shadow.
  const cloudSandbox = mkdtempSync(join(tmpdir(), 'career-ops-queue-cloud-deferral-'));
  try {
    const cloudQueuePath = join(cloudSandbox, 'apply-queue.json');
    const storedCloudQueue = { version: 1, settings: {}, roles: [cloudExhausted] };
    const originalCloudJson = JSON.stringify(storedCloudQueue);
    writeFileSync(cloudQueuePath, originalCloudJson);
    const cloudEnv = {
      ...process.env,
      CAREER_OPS_QUEUE_BACKEND: 'supabase',
      CAREER_OPS_DATA_DIR: cloudSandbox,
      SUPABASE_URL: '',
      SUPABASE_DASHBOARD_KEY: '',
      SUPABASE_CRON_PUBLISHABLE_KEY: '',
      SUPABASE_CRON_JWT: '',
    };
    const cloudOut = execFileSync(
      process.execPath,
      ['queue-sweep.mjs', '--summary'],
      { cwd: ROOT, env: cloudEnv, encoding: 'utf-8' },
    );
    if (cloudOut.includes('still open no-jd: 1 (including 1 closure-deferred)') &&
        readFileSync(cloudQueuePath, 'utf-8') === originalCloudJson) {
      pass('Supabase CLI sweep detects the backend, defers closure, and performs no shadow write');
    } else {
      fail(`Supabase CLI deferral wrong: ${JSON.stringify({ cloudOut })}`);
    }
  } finally {
    rmSync(cloudSandbox, { recursive: true, force: true });
  }

  // Exercise the exact commands used by modes/queue.md against an isolated
  // local store. This proves the workflow wiring without touching the user's
  // queue or relying on cloud credentials.
  const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-queue-lifecycle-'));
  try {
    const queuePath = join(sandbox, 'apply-queue.json');
    const cliRole = {
      id: 'test:retry:1',
      status: 'new',
      company: 'TestCo',
      title: 'Data Engineer',
      url: 'https://example.test/jobs/1',
      flags: ['no-jd', 'login-required'],
      jd_fetch: {
        class: 'deterministic',
        attempts: 1,
        first_failed_at: day(0),
        last_attempt_at: day(0),
        reason: 'login required',
      },
    };
    writeFileSync(queuePath, JSON.stringify({ version: 1, settings: {}, roles: [cliRole] }));
    const env = {
      ...process.env,
      CAREER_OPS_QUEUE_BACKEND: 'local',
      CAREER_OPS_DATA_DIR: sandbox,
      // Explicitly blank so dotenv cannot turn this isolated test into a cloud call.
      SUPABASE_URL: '',
      SUPABASE_DASHBOARD_KEY: '',
      SUPABASE_CRON_PUBLISHABLE_KEY: '',
      SUPABASE_CRON_JWT: '',
    };
    const retryOut = execFileSync(
      process.execPath,
      ['queue-sweep.mjs', 'retryable', cliRole.id],
      { cwd: ROOT, env, encoding: 'utf-8' },
    );
    const retryDecision = JSON.parse(retryOut);
    if (retryDecision.attempt === false && retryDecision.code === 'manual-action-required') {
      pass('retryable CLI enforces the deterministic zero-auto-retry decision offline');
    } else {
      fail(`retryable CLI decision wrong: ${JSON.stringify(retryDecision)}`);
    }

    const stored = JSON.parse(readFileSync(queuePath, 'utf-8'));
    stored.roles[0].jd_text = realJd;
    writeFileSync(queuePath, JSON.stringify(stored));
    const recoverOut = execFileSync(
      process.execPath,
      ['queue-sweep.mjs', 'recover', cliRole.id],
      { cwd: ROOT, env, encoding: 'utf-8' },
    );
    const recoverDecision = JSON.parse(recoverOut);
    const afterRecover = JSON.parse(readFileSync(queuePath, 'utf-8')).roles[0];
    if (recoverDecision.ok && recoverDecision.changed &&
        !('jd_fetch' in afterRecover) &&
        !afterRecover.flags.includes('no-jd') &&
        afterRecover.flags.includes('login-required')) {
      pass('recover CLI persists checked marker cleanup in an isolated local queue');
    } else {
      fail(`recover CLI persistence wrong: ${JSON.stringify({ recoverDecision, afterRecover })}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

} catch (error) {
  fail(`queue lifecycle tests crashed: ${error.stack || error.message}`);
}
