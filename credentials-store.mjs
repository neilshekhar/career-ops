#!/usr/bin/env node
/**
 * credentials-store.mjs — Per-portal credential manager.
 *
 * Stores a unique auto-generated password per portal host in a gitignored
 * JSON file (data/portal-credentials.json). Values are used only by the
 * automated login/registration flow and are never printed.
 *
 * The file is NEVER committed (gitignored). Store absence never proves that a
 * portal account is new: callers must attempt registration only on an actual
 * registration form, and fall back to manual login (never password recovery)
 * if the portal reports that the email already exists.
 *
 * Exports:
 *   normalizePortalHost(host)           → exact canonical host
 *   generatePassword(policy?)           → compliant random password
 *   passwordMeetsPolicy(password, policy?) → boolean
 *   getCredentials(host, url?)          → { email, password, created_at } | null
 *   bindAcceptedRegistrationObservation(role, evidence, { queue }) → metadata
 *   commitAcceptedRegistrationCredentials(host, email, pw, evidence) → metadata
 *   upsertCredentials(host, email, pw, evidence) → compatibility alias requiring evidence
 *
 * Secret-free binding CLI:
 *   node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'
 */

import {
  readFileSync, existsSync, mkdirSync, renameSync,
  openSync, writeSync, closeSync, chmodSync, rmSync, statSync, constants,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash, randomUUID, randomBytes } from 'crypto';

const ROOT         = dirname(fileURLToPath(import.meta.url));
const DATA_DIR     = process.env.CAREER_OPS_DATA_DIR
  ? resolve(process.env.CAREER_OPS_DATA_DIR)
  : join(ROOT, 'data');
const CREDS_PATH   = join(DATA_DIR, 'portal-credentials.json');
const CREDS_LOCK   = join(DATA_DIR, '.portal-credentials.lock');
const QUEUE_PATH   = join(DATA_DIR, 'apply-queue.json');

export function normalizePortalHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.includes('/') || value.includes('\\') || /\s/.test(value)) {
    throw new Error('Invalid portal host');
  }
  return value;
}

const SUCCESSFACTORS_HOST = /(?:^|\.)successfactors\.(?:com|eu|cn)$/i;
const SUCCESSFACTORS_SHARED_HOST = /^career\d+\./i;
const PAGEUP_HOST = /(?:^|\.)pageuppeople\.com$/i;
const BRASSRING_HOST = /(?:^|\.)brassring\.com$/i;
const UKG_RECRUITING_HOST = /^recruiting\d*\.ultipro\.(?:com|ca)$/i;
const ADP_WORKFORCE_NOW_HOST = 'workforcenow.adp.com';
const DAYFORCE_JOBS_HOST = 'jobs.dayforcehcm.com';
const DAYFORCE_LEGACY_HOST = 'www.dayforcehcm.com';

function portalTenantValue(value, label) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Invalid ${label} portal tenant identifier`);
  }
  return text;
}

function queryParam(parsed, name) {
  const values = [];
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === name.toLowerCase()) values.push(value);
  }
  if (values.length === 0) return null;
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) {
    throw new Error(`Ambiguous portal tenant parameter: ${name}`);
  }
  return portalTenantValue(distinct[0], name);
}

function decodedPathSegments(parsed) {
  return parsed.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new Error('Invalid percent-encoding in portal URL path');
    }
  });
}

function portalKeyFromParts(exactHost, parts) {
  if (!parts.length) return exactHost;
  const params = new URLSearchParams();
  for (const [name, value] of parts) {
    params.append(name, portalTenantValue(value, name));
  }
  return `${exactHost}?${params.toString()}`;
}

/**
 * Return only credential-realm identifiers that are documented by the ATS URL
 * family. Do not treat a generic `company=` query parameter as authoritative:
 * unrelated portals legitimately use that name for filters and attribution.
 */
function tenantPartsFromPortalUrl(exactHost, parsed) {
  if (SUCCESSFACTORS_HOST.test(exactHost)) {
    const company = queryParam(parsed, 'company');
    if (!company && SUCCESSFACTORS_SHARED_HOST.test(exactHost)) {
      throw new Error('Shared SuccessFactors portal URL is missing its company tenant parameter');
    }
    return company ? [['company', company]] : [];
  }

  if (PAGEUP_HOST.test(exactHost)) {
    const segments = decodedPathSegments(parsed);
    if (segments[0]?.toLowerCase() !== 'apply') return [];
    if (!segments[1]) throw new Error('PageUp apply URL is missing its client tenant path');
    return [['client', segments[1]]];
  }

  if (BRASSRING_HOST.test(exactHost)) {
    const partnerId = queryParam(parsed, 'partnerid');
    const siteId = queryParam(parsed, 'siteid');
    if ((partnerId && !siteId) || (!partnerId && siteId)) {
      throw new Error('BrassRing portal URL has an incomplete partnerid/siteid tenant pair');
    }
    // Both values identify the candidate portal. With neither value present,
    // this is only a generic platform page and remains bare-host keyed.
    return partnerId && siteId
      ? [['partnerid', partnerId], ['siteid', siteId]]
      : [];
  }

  if (exactHost === ADP_WORKFORCE_NOW_HOST) {
    const clientId = queryParam(parsed, 'cid');
    return clientId ? [['cid', clientId]] : [];
  }

  if (exactHost === DAYFORCE_JOBS_HOST) {
    const segments = decodedPathSegments(parsed);
    if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[0] ?? '')) segments.shift();
    if (!segments[0]) return [];
    const parts = [['client', segments[0]]];
    if (segments[1] && !/^(?:jobs|job|profile)$/i.test(segments[1])) {
      parts.push(['site', segments[1]]);
    }
    return parts;
  }

  if (exactHost === DAYFORCE_LEGACY_HOST) {
    const segments = decodedPathSegments(parsed);
    if (segments[0]?.toLowerCase() !== 'candidateportal') return [];
    let index = 1;
    if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[index] ?? '')) index++;
    return segments[index] ? [['client', segments[index]]] : [];
  }

  if (UKG_RECRUITING_HOST.test(exactHost)) {
    const segments = decodedPathSegments(parsed);
    return segments[0] && segments.some((part) => part.toLowerCase() === 'jobboard')
      ? [['company', segments[0]]]
      : [];
  }

  return [];
}

// Some ATS platforms host credentially-distinct employer tenants behind one
// hostname. The tenant is always derived from the observed portal URL using
// the host family's documented URL shape, never from a free caller-supplied
// tenant field. Ordinary hosts and unmatched URL shapes remain bare-host keyed.
export function derivePortalKey(host, url) {
  const exactHost = normalizePortalHost(host);
  if (url == null) return exactHost;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (error) {
    throw new Error(`Invalid portal URL: ${error.message}`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Portal URL must use http or https');
  }
  if (normalizePortalHost(parsed.host) !== exactHost) {
    throw new Error('Portal URL host does not match the exact portal host');
  }
  return portalKeyFromParts(exactHost, tenantPartsFromPortalUrl(exactHost, parsed));
}

/**
 * Canonicalize either an observed portal URL or one of the persisted key
 * formats emitted above. Used by the one-time rekey maintenance path so a
 * typo/case variant cannot move the only password to an unreachable key.
 */
export function normalizePortalKey(keyOrUrl) {
  const input = String(keyOrUrl ?? '').trim();
  if (!input) throw new Error('Portal credential key is required');
  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    return derivePortalKey(parsed.host, parsed.toString());
  }

  const separator = input.indexOf('?');
  const exactHost = normalizePortalHost(separator === -1 ? input : input.slice(0, separator));
  if (separator === -1) return exactHost;
  const rawQuery = input.slice(separator + 1);
  if (!rawQuery) throw new Error('Portal credential key has an empty tenant qualifier');
  const parsed = new URL(`https://${exactHost}/?${rawQuery}`);
  const params = [...parsed.searchParams].map(([name, value]) => [
    name.toLowerCase(),
    portalTenantValue(value, name),
  ]);

  let allowed;
  if (SUCCESSFACTORS_HOST.test(exactHost) || UKG_RECRUITING_HOST.test(exactHost)) {
    allowed = ['company'];
  } else if (PAGEUP_HOST.test(exactHost)) {
    allowed = ['client'];
  } else if (BRASSRING_HOST.test(exactHost)) {
    allowed = ['partnerid', 'siteid'];
  } else if (exactHost === ADP_WORKFORCE_NOW_HOST) {
    allowed = ['cid'];
  } else if ([DAYFORCE_JOBS_HOST, DAYFORCE_LEGACY_HOST].includes(exactHost)) {
    allowed = params.some(([name]) => name === 'site') ? ['client', 'site'] : ['client'];
  } else {
    throw new Error('Tenant-qualified credential keys are not supported for this portal host');
  }
  if (params.length !== allowed.length ||
      params.some(([name], index) => name !== allowed[index])) {
    throw new Error(`Portal credential key must use: ${allowed.join(', ')}`);
  }
  return portalKeyFromParts(exactHost, params);
}

// ── I/O ───────────────────────────────────────────────────────────────────────

function loadStore() {
  if (!existsSync(CREDS_PATH)) return {};
  // Fix permissions on any historically permissive copy.
  try { chmodSync(CREDS_PATH, 0o600); } catch { /* ignore — may not own the file */ }
  try {
    const value = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a JSON object');
    }
    return value;
  } catch (err) {
    throw new Error(`Portal credential store is unreadable or invalid; refusing account creation/login: ${err.message}`);
  }
}

function saveStore(store) {
  // Directory: owner-only so other users can't even list it
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  const tmp  = join(DATA_DIR, `.portal-credentials-${randomUUID()}.tmp`);
  const data = JSON.stringify(store, null, 2) + '\n';

  // Open temp file with O_CREAT|O_WRONLY|O_TRUNC and mode 0o600 so it is never
  // world- or group-readable, even briefly while the write is in progress.
  const fd = openSync(tmp, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC, 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, CREDS_PATH); // atomic on same filesystem
}

function withStoreLock(fn, timeoutMs = 10_000) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(CREDS_LOCK, { mode: 0o700 });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(CREDS_LOCK).mtimeMs > 60_000) {
          rmSync(CREDS_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch { /* another process may have released it */ }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for portal credential store lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(CREDS_LOCK, { recursive: true, force: true });
  }
}

// ── Password generation ───────────────────────────────────────────────────────

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const DEFAULT_SYMBOLS = '!@#$%^&*_-';
const DEFAULT_PASSWORD_LENGTH = 24;
const MAX_PASSWORD_LENGTH = 256;
const DEFAULT_GENERATION_ATTEMPTS = 512;

function firstDefined(source, names, fallback = undefined) {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  return fallback;
}

function integerConstraint(value, name, { min = 0, max = MAX_PASSWORD_LENGTH } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Invalid password policy: ${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function uniqueCharacters(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw new Error(`Invalid password policy: ${name} must be a string or character array`);
  }
  const characters = Array.from(typeof value === 'string' ? value : value.join(''));
  if (characters.some((character) => Array.from(character).length !== 1)) {
    throw new Error(`Invalid password policy: ${name} contains an invalid character`);
  }
  return [...new Set(characters)].join('');
}

function stringList(value, name) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid password policy: ${name} must contain strings only`);
  }
  return [...new Set(values.filter(Boolean))];
}

function compilePolicyPattern(value) {
  if (value == null || value === '') return null;
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid password policy: pattern must be a RegExp or HTML-pattern string');
  }
  try {
    // HTML input patterns apply to the whole value, so string patterns use the
    // same full-match semantics. Callers may pass a RegExp for different semantics.
    return new RegExp(`^(?:${value})$`, 'u');
  } catch (error) {
    throw new Error(`Invalid password policy pattern: ${error.message}`);
  }
}

function categoryCharacters(pool, category) {
  return Array.from(pool).filter((character) => {
    if (category === 'uppercase') return /\p{Lu}/u.test(character);
    if (category === 'lowercase') return /\p{Ll}/u.test(character);
    if (category === 'digit') return /\p{Nd}/u.test(character);
    return !/[\p{L}\p{N}\s]/u.test(character);
  }).join('');
}

function normalizePasswordPolicy(policy = {}) {
  if (policy == null) policy = {};
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Invalid password policy: expected a constraints object');
  }

  const exactLengthRaw = firstDefined(policy, ['length', 'exactLength', 'exact_length']);
  const exactLength = exactLengthRaw == null
    ? null
    : integerConstraint(exactLengthRaw, 'length', { min: 1 });
  const maximumRaw = firstDefined(policy, ['maxLength', 'max_length', 'maxlength']);
  const maximum = maximumRaw == null
    ? MAX_PASSWORD_LENGTH
    : integerConstraint(maximumRaw, 'maxLength', { min: 1 });
  const minimumRaw = firstDefined(policy, ['minLength', 'min_length', 'minlength']);
  const minimum = minimumRaw == null
    ? Math.min(12, maximum, exactLength ?? maximum)
    : integerConstraint(minimumRaw, 'minLength', { min: 1 });
  if (minimum > maximum) {
    throw new Error('Invalid password policy: minLength exceeds maxLength');
  }

  let length;
  if (exactLength != null) {
    length = exactLength;
    if (length < minimum || length > maximum) {
      throw new Error('Invalid password policy: length is outside minLength/maxLength');
    }
  } else {
    const preferredRaw = firstDefined(policy, ['preferredLength', 'preferred_length']);
    const preferred = preferredRaw == null
      ? DEFAULT_PASSWORD_LENGTH
      : integerConstraint(preferredRaw, 'preferredLength', { min: 1 });
    length = Math.max(minimum, Math.min(preferred, maximum));
  }

  const forbiddenCharactersRaw = firstDefined(
    policy,
    ['forbiddenCharacters', 'forbidden_characters', 'disallowedCharacters'],
  );
  const forbiddenCharacters = uniqueCharacters(
    forbiddenCharactersRaw,
    'forbiddenCharacters',
  ) ?? '';
  const forbidden = new Set(Array.from(forbiddenCharacters));
  const explicitAllowed = uniqueCharacters(
    firstDefined(policy, ['allowedCharacters', 'allowed_characters']),
    'allowedCharacters',
  );
  const allowedSymbolsRaw = firstDefined(
    policy,
    [
      'allowedSymbols', 'allowed_symbols', 'specialCharacters', 'special_characters',
      'allowedSpecialCharacters', 'allowed_special_characters',
    ],
  );
  const allowedSymbols = uniqueCharacters(
    allowedSymbolsRaw == null ? DEFAULT_SYMBOLS : allowedSymbolsRaw,
    'allowedSymbols',
  ) ?? '';
  const allowWhitespace = firstDefined(policy, ['allowWhitespace', 'allow_whitespace'], false) === true;
  const basePool = explicitAllowed ?? `${UPPERCASE}${LOWERCASE}${DIGITS}${allowedSymbols}`;
  const pool = [...new Set(Array.from(basePool))]
    .filter((character) => !forbidden.has(character))
    .filter((character) => allowWhitespace || !/\s/u.test(character))
    .join('');
  if (!pool) throw new Error('Invalid password policy: no allowed characters remain');

  const groups = {
    uppercase: categoryCharacters(pool, 'uppercase'),
    lowercase: categoryCharacters(pool, 'lowercase'),
    digit: categoryCharacters(pool, 'digit'),
    symbol: categoryCharacters(pool, 'symbol'),
  };
  // An explicitly restricted pool/symbol list is authoritative. When it removes
  // a category entirely, that category defaults to zero unless the displayed
  // policy explicitly requires it (in which case validation fails closed).
  const restrictedPool = explicitAllowed != null
    || allowedSymbolsRaw != null
    || forbiddenCharactersRaw != null;
  const countFor = (category, countNames, requireNames) => {
    const explicitCount = firstDefined(policy, countNames);
    if (explicitCount != null) {
      return integerConstraint(explicitCount, countNames[0], { min: 0 });
    }
    const required = firstDefined(policy, requireNames);
    if (required != null && typeof required !== 'boolean') {
      throw new Error(`Invalid password policy: ${requireNames[0]} must be boolean`);
    }
    if (required === false) return 0;
    if (required === true) return 1;
    return restrictedPool && !groups[category] ? 0 : 1;
  };

  const minimumCounts = {
    uppercase: countFor(
      'uppercase',
      ['minUppercase', 'min_uppercase'],
      ['requireUppercase', 'require_uppercase', 'requiresUppercase'],
    ),
    lowercase: countFor(
      'lowercase',
      ['minLowercase', 'min_lowercase'],
      ['requireLowercase', 'require_lowercase', 'requiresLowercase'],
    ),
    digit: countFor(
      'digit',
      ['minDigits', 'min_digits', 'minNumbers', 'min_numbers'],
      ['requireDigit', 'require_digit', 'requireNumber', 'require_number', 'requiresDigit'],
    ),
    symbol: countFor(
      'symbol',
      ['minSymbols', 'min_symbols', 'minSpecial', 'min_special'],
      ['requireSymbol', 'require_symbol', 'requireSpecial', 'require_special', 'requiresSymbol'],
    ),
  };

  for (const [category, count] of Object.entries(minimumCounts)) {
    if (count > 0 && !groups[category]) {
      throw new Error(`Invalid password policy: ${category} is required but no allowed characters satisfy it`);
    }
  }
  const requiredCharacters = Object.values(minimumCounts).reduce((sum, count) => sum + count, 0);
  if (requiredCharacters > length) {
    throw new Error('Invalid password policy: required character counts exceed password length');
  }

  const maxConsecutiveRaw = firstDefined(
    policy,
    ['maxConsecutiveIdentical', 'max_consecutive_identical'],
  );
  const maxConsecutiveIdentical = maxConsecutiveRaw == null
    ? null
    : integerConstraint(maxConsecutiveRaw, 'maxConsecutiveIdentical', { min: 1 });
  const validate = firstDefined(policy, ['validate', 'validator']);
  if (validate != null && typeof validate !== 'function') {
    throw new Error('Invalid password policy: validate must be a function');
  }
  const attemptsRaw = firstDefined(policy, ['maxAttempts', 'max_attempts']);
  const maxAttempts = attemptsRaw == null
    ? DEFAULT_GENERATION_ATTEMPTS
    : integerConstraint(attemptsRaw, 'maxAttempts', { min: 1, max: 4096 });

  return {
    length,
    exactLength,
    minimum,
    maximum,
    pool,
    groups,
    minimumCounts,
    forbiddenSubstrings: stringList(
      firstDefined(policy, ['forbiddenSubstrings', 'forbidden_substrings']),
      'forbiddenSubstrings',
    ),
    rejectedPasswords: new Set(stringList(
      firstDefined(policy, ['rejectedPasswords', 'rejected_passwords']),
      'rejectedPasswords',
    )),
    maxConsecutiveIdentical,
    pattern: compilePolicyPattern(firstDefined(policy, ['pattern', 'htmlPattern', 'html_pattern'])),
    validate,
    maxAttempts,
  };
}

function passwordPolicyErrorsNormalized(password, policy) {
  if (typeof password !== 'string') return ['password must be a string'];
  const characters = Array.from(password);
  const errors = [];
  if (characters.length < policy.minimum) errors.push('password is shorter than minLength');
  if (characters.length > policy.maximum) errors.push('password is longer than maxLength');
  if (policy.exactLength != null && characters.length !== policy.exactLength) {
    errors.push('password does not satisfy exact length');
  }
  const allowed = new Set(Array.from(policy.pool));
  if (characters.some((character) => !allowed.has(character))) {
    errors.push('password contains a character outside the allowed set');
  }
  for (const [category, minimum] of Object.entries(policy.minimumCounts)) {
    const count = characters.filter((character) => policy.groups[category].includes(character)).length;
    if (count < minimum) errors.push(`password does not satisfy min ${category} count`);
  }
  for (const substring of policy.forbiddenSubstrings) {
    if (password.includes(substring)) errors.push('password contains a forbidden substring');
  }
  if (policy.maxConsecutiveIdentical != null) {
    let run = 1;
    for (let index = 1; index < characters.length; index++) {
      run = characters[index] === characters[index - 1] ? run + 1 : 1;
      if (run > policy.maxConsecutiveIdentical) {
        errors.push('password exceeds max consecutive identical characters');
        break;
      }
    }
  }
  if (policy.pattern && !policy.pattern.test(password)) {
    errors.push('password does not match the portal pattern');
  }
  if (policy.rejectedPasswords.has(password)) {
    errors.push('password was previously rejected');
  }
  if (policy.validate) {
    try {
      if (policy.validate(password) !== true) errors.push('password failed custom validation');
    } catch {
      errors.push('password policy validator could not verify candidate');
    }
  }
  return errors;
}

function unbiasedIndex(length) {
  if (!Number.isInteger(length) || length < 1 || length > 256) {
    throw new Error('Password character pool must contain between 1 and 256 characters');
  }
  const limit = Math.floor(256 / length) * length;
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < limit) return byte % length;
  }
}

function pick(chars) {
  const characters = Array.from(chars);
  return characters[unbiasedIndex(characters.length)];
}

function candidateForPolicy(policy) {
  const chars = [];
  for (const [category, minimum] of Object.entries(policy.minimumCounts)) {
    for (let index = 0; index < minimum; index++) chars.push(pick(policy.groups[category]));
  }
  while (chars.length < policy.length) chars.push(pick(policy.pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = unbiasedIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Return validation messages without ever echoing the password itself.
 * The structured policy may use DOM/displayed constraints such as minLength,
 * maxLength, HTML pattern, allowedSymbols, forbiddenCharacters, category
 * minimums, forbiddenSubstrings, or a controller-provided validator.
 */
export function passwordPolicyErrors(password, policy = {}) {
  return passwordPolicyErrorsNormalized(password, normalizePasswordPolicy(policy));
}

export function passwordMeetsPolicy(password, policy = {}) {
  return passwordPolicyErrors(password, policy).length === 0;
}

// Defaults remain 24 characters with guaranteed upper/lower/digit/symbol
// coverage. A live registration controller passes the portal's displayed/DOM
// constraints so rejected hardcoded defaults are never persisted. To regenerate
// after rejection, pass every rejected in-memory value via rejectedPasswords;
// the same helper guarantees the replacement differs without touching the store.
export function generatePassword(policy = {}) {
  const normalized = normalizePasswordPolicy(policy);
  for (let attempt = 0; attempt < normalized.maxAttempts; attempt++) {
    const candidate = candidateForPolicy(normalized);
    if (passwordPolicyErrorsNormalized(candidate, normalized).length === 0) return candidate;
  }
  throw new Error(
    `Unable to generate a password satisfying the displayed portal policy after ${normalized.maxAttempts} attempts`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get stored credentials for a portal host.
 * @param {string} host  — e.g. 'jobs.careers.vic.gov.au'
 * @param {string} [url] — the exact page URL being logged into; required to
 *   resolve multi-tenant hosts (e.g. career10.successfactors.com?company=...).
 *   A lookup that carries a tenant param matches only that tenant's key —
 *   never falls back to the bare-host entry, which would silently return a
 *   different tenant's credentials.
 * @returns {{ email: string, password: string, created_at: string } | null}
 */
export function getCredentials(host, url) {
  const key = derivePortalKey(host, url);
  return loadStore()[key] ?? null;
}

export const REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION = 2;
export const REGISTRATION_QUEUE_BINDING_VERSION = 1;

const ACTIVE_REGISTRATION_REQUEST_STATES = new Set(['queued', 'in-progress']);
const REGISTRATION_ALLOWED_ROLE_STATUSES = new Set(['prepared', 'prefilled']);
const REGISTRATION_ACCEPTANCE_SIGNALS = new Set([
  'registration-accepted',
  'verification-required',
  'authenticated',
]);
const APPLICATION_REQUEST_CONTRACT = Object.freeze([
  'modes/apply.md',
  'modes/_custom.md',
  'queue-resolve.mjs',
  'application-receipt.mjs',
]);

function requiredCredentialText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function acceptedRegistrationEvidence(host, email, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Accepted registration evidence is required before credentials can be persisted');
  }
  const exactHost = normalizePortalHost(host);
  if (evidence.version !== REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION) {
    throw new Error('Accepted registration evidence version is missing or stale');
  }
  if (evidence.classification !== 'registration-accepted' || evidence.result !== 'accepted') {
    throw new Error('Portal registration acceptance was not confirmed');
  }
  if (evidence.account_created !== true) {
    throw new Error('Accepted registration evidence must confirm account creation');
  }
  if (evidence.application_submission_detected !== false) {
    throw new Error('Credential persistence cannot use final-application submission evidence');
  }
  const roleId = requiredCredentialText(evidence.role_id, 'registration evidence role_id');
  const applicationRequestId = requiredCredentialText(
    evidence.application_request_id,
    'registration evidence application_request_id',
  );
  const runId = requiredCredentialText(evidence.run_id, 'registration evidence run_id');
  const controllerId = requiredCredentialText(
    evidence.controller_id,
    'registration evidence controller_id',
  );
  const tabId = requiredCredentialText(evidence.tab_id, 'registration evidence tab_id');
  if (evidence.observation_source !== 'playwright-mcp') {
    throw new Error('Accepted registration evidence must come from a Playwright MCP observation');
  }
  const acceptanceSignal = requiredCredentialText(
    evidence.acceptance_signal,
    'registration evidence acceptance_signal',
  );
  if (!REGISTRATION_ACCEPTANCE_SIGNALS.has(acceptanceSignal)) {
    throw new Error(
      'Accepted registration evidence must record an accepted, verification-required, or authenticated signal',
    );
  }
  const evidenceHost = normalizePortalHost(evidence.portal_host);
  if (evidenceHost !== exactHost) {
    throw new Error('Accepted registration evidence belongs to a different portal host');
  }
  let registrationUrl;
  try {
    registrationUrl = new URL(requiredCredentialText(
      evidence.registration_url,
      'registration evidence URL',
    ));
  } catch (error) {
    throw new Error(`Accepted registration evidence URL is invalid: ${error.message}`);
  }
  if (!['https:', 'http:'].includes(registrationUrl.protocol)) {
    throw new Error('Accepted registration evidence URL must use http or https');
  }
  if (normalizePortalHost(registrationUrl.host) !== exactHost) {
    throw new Error('Accepted registration evidence URL belongs to a different portal host');
  }
  // Tenant is derived from this already-validated URL, never from a
  // caller-supplied field, so it cannot be spoofed independent of the URL.
  const portalKey = derivePortalKey(exactHost, registrationUrl.toString());
  const accountEmail = requiredCredentialText(
    evidence.account_email,
    'registration evidence account_email',
  );
  if (accountEmail.toLowerCase() !== email.toLowerCase()) {
    throw new Error('Accepted registration evidence belongs to a different account email');
  }
  const acceptedAt = requiredCredentialText(evidence.accepted_at, 'registration evidence accepted_at');
  if (!Number.isFinite(Date.parse(acceptedAt))) {
    throw new Error('Accepted registration evidence timestamp is invalid');
  }
  const snapshotDigest = requiredCredentialText(
    evidence.snapshot_digest,
    'registration evidence snapshot_digest',
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(snapshotDigest)) {
    throw new Error('Accepted registration evidence snapshot_digest must be SHA-256');
  }
  const registrationControlId = requiredCredentialText(
    evidence.registration_control_id,
    'registration evidence registration_control_id',
  );
  return {
    version: REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION,
    classification: 'registration-accepted',
    result: 'accepted',
    portal_host: exactHost,
    portal_key: portalKey,
    registration_url: registrationUrl.toString(),
    account_email: accountEmail,
    account_created: true,
    application_submission_detected: false,
    role_id: roleId,
    application_request_id: applicationRequestId,
    run_id: runId,
    controller_id: controllerId,
    tab_id: tabId,
    observation_source: 'playwright-mcp',
    acceptance_signal: acceptanceSignal,
    accepted_at: new Date(acceptedAt).toISOString(),
    snapshot_digest: snapshotDigest,
    registration_control_id: registrationControlId,
  };
}

function readRegistrationQueueSnapshot() {
  if (!existsSync(QUEUE_PATH)) {
    throw new Error(
      'Durable apply queue is missing; credentials require an active dashboard application request',
    );
  }
  try {
    const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
    if (!queue || typeof queue !== 'object' || Array.isArray(queue) || !Array.isArray(queue.roles)) {
      throw new Error('expected a queue object with roles[]');
    }
    return queue;
  } catch (error) {
    throw new Error(`Durable apply queue is unreadable or invalid: ${error.message}`);
  }
}

function registrationEvidenceDigest(evidence) {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function registrationQueueBinding(queue, accepted, { requireRecordedObservation = true } = {}) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue) || !Array.isArray(queue.roles)) {
    throw new Error('Registration validation context must contain the durable queue roles');
  }
  const role = queue.roles.find((item) => item?.id === accepted.role_id);
  if (!role) throw new Error('Accepted registration evidence is not bound to a queued role');
  if (!REGISTRATION_ALLOWED_ROLE_STATUSES.has(role.status)) {
    throw new Error('Queued role is not eligible for live account registration');
  }

  const request = role.application_request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('A durable dashboard application_request is required for credential persistence');
  }
  if (request.version !== 1 || request.controller !== 'active-agent' ||
      !ACTIVE_REGISTRATION_REQUEST_STATES.has(request.state)) {
    throw new Error('Dashboard application_request is missing, stale, or inactive');
  }
  if (!/^dashboard(?:-|$)/.test(requiredCredentialText(
    request.source,
    'application_request.source',
  ))) {
    throw new Error('Credential persistence requires a dashboard-originated application_request');
  }
  if (JSON.stringify(request.contract) !== JSON.stringify(APPLICATION_REQUEST_CONTRACT)) {
    throw new Error('Dashboard application_request contract is missing or stale');
  }
  if (request.role_id !== role.id || request.request_id !== `${request.run_id}:${role.id}`) {
    throw new Error('Dashboard application_request role/run identity is invalid');
  }
  if (accepted.application_request_id !== request.request_id ||
      accepted.run_id !== request.run_id || accepted.controller_id !== request.controller_id) {
    throw new Error('Accepted registration evidence belongs to a different request, run, or controller');
  }
  const requestedAt = Date.parse(requiredCredentialText(
    request.requested_at,
    'application_request.requested_at',
  ));
  if (!Number.isFinite(requestedAt) || Date.parse(accepted.accepted_at) < requestedAt) {
    throw new Error('Accepted registration observation predates its dashboard application request');
  }

  const lease = queue.settings?.application_controller;
  if (!lease || lease.version !== 1 || lease.controller !== 'active-agent' ||
      lease.controller_id !== request.controller_id || Number(lease.max_active_roles) !== 4) {
    throw new Error('Accepted registration evidence is not bound to the active browser-controller lease');
  }
  const activeRequests = queue.roles.filter((item) =>
    ACTIVE_REGISTRATION_REQUEST_STATES.has(item?.application_request?.state));
  if (activeRequests.length > 4 || activeRequests.some((item) =>
    item.application_request.controller_id !== lease.controller_id)) {
    throw new Error('Active application requests do not share one valid browser-controller lease');
  }

  const progress = role.application_progress;
  if (request.state === 'in-progress') {
    if (!progress || progress.run_id !== request.run_id ||
        progress.application_request_id !== request.request_id ||
        progress.controller_id !== request.controller_id ||
        progress.tab?.id !== accepted.tab_id) {
      throw new Error('Accepted registration evidence does not match the active receipt run/tab');
    }
  } else if (progress) {
    throw new Error('Queued pre-receipt registration cannot carry an unrelated application_progress');
  }
  if (request.tab_id && request.tab_id !== accepted.tab_id) {
    throw new Error('Accepted registration evidence belongs to a different application tab');
  }
  for (const other of queue.roles) {
    if (other?.id === role.id) continue;
    const otherTab = other?.application_progress?.tab?.id ??
      other?.application_request?.registration_acceptance?.tab_id;
    if (otherTab && otherTab === accepted.tab_id) {
      throw new Error('Accepted registration tab is already bound to another queued role');
    }
  }

  const evidenceSha256 = registrationEvidenceDigest(accepted);
  if (requireRecordedObservation) {
    const recorded = request.registration_acceptance;
    if (!recorded || recorded.version !== REGISTRATION_QUEUE_BINDING_VERSION ||
        recorded.evidence_sha256 !== evidenceSha256 || recorded.role_id !== role.id ||
        recorded.application_request_id !== request.request_id ||
        recorded.run_id !== request.run_id || recorded.controller_id !== request.controller_id ||
        recorded.tab_id !== accepted.tab_id) {
      throw new Error(
        'Durable Playwright registration observation is missing or does not match; bind it before committing credentials',
      );
    }
  }
  return { role, request, evidence_sha256: evidenceSha256 };
}

/**
 * Bind a secret-free Playwright acceptance observation to the active queued
 * role/request/controller/tab. The caller persists the mutated queue through
 * queue-store.mjs before committing the staged password. This binding is
 * intentionally separate from the credential commit: a caller-authored
 * evidence object alone can never write the credential store.
 */
export function bindAcceptedRegistrationObservation(role, evidence, { queue } = {}) {
  if (!role?.id) throw new Error('Queued role is required for registration observation binding');
  const exactHost = normalizePortalHost(evidence?.portal_host);
  const accountEmail = requiredCredentialText(
    evidence?.account_email,
    'registration evidence account_email',
  );
  const accepted = acceptedRegistrationEvidence(exactHost, accountEmail, evidence);
  if (accepted.role_id !== role.id) {
    throw new Error('Accepted registration evidence belongs to a different queued role');
  }
  const durableQueue = queue ?? { settings: {}, roles: [role] };
  const binding = registrationQueueBinding(durableQueue, accepted, {
    requireRecordedObservation: false,
  });
  const existing = binding.request.registration_acceptance;
  if (existing && existing.evidence_sha256 !== binding.evidence_sha256) {
    throw new Error('A different registration acceptance is already bound to this application request');
  }
  binding.request.registration_acceptance = {
    version: REGISTRATION_QUEUE_BINDING_VERSION,
    role_id: role.id,
    application_request_id: binding.request.request_id,
    run_id: binding.request.run_id,
    controller_id: binding.request.controller_id,
    tab_id: accepted.tab_id,
    portal_host: accepted.portal_host,
    registration_url: accepted.registration_url,
    observation_source: accepted.observation_source,
    acceptance_signal: accepted.acceptance_signal,
    accepted_at: accepted.accepted_at,
    snapshot_digest: accepted.snapshot_digest,
    registration_control_id: accepted.registration_control_id,
    evidence_sha256: binding.evidence_sha256,
    bound_at: new Date().toISOString(),
  };
  return {
    bound: true,
    role_id: role.id,
    application_request_id: binding.request.request_id,
    run_id: binding.request.run_id,
    controller_id: binding.request.controller_id,
    tab_id: accepted.tab_id,
    portal_host: accepted.portal_host,
  };
}

export function validateAcceptedRegistrationEvidence(
  host,
  email,
  evidence,
) {
  const normalizedEmail = requiredCredentialText(email, 'email');
  const accepted = acceptedRegistrationEvidence(host, normalizedEmail, evidence);
  const queue = readRegistrationQueueSnapshot();
  registrationQueueBinding(queue, accepted);
  return accepted;
}

/**
 * Persist staged credentials only after the exact portal host has accepted
 * account registration. Password generation remains a separate in-memory step.
 * @param {string} host
 * @param {string} email
 * @param {string} password
 * @param {object} evidence
 */
export function commitAcceptedRegistrationCredentials(
  host,
  email,
  password,
  evidence,
) {
  const exactHost = normalizePortalHost(host);
  const normalizedEmail = requiredCredentialText(email, 'email');
  const stagedPassword = requiredCredentialText(password, 'password');
  const accepted = validateAcceptedRegistrationEvidence(
    exactHost,
    normalizedEmail,
    evidence,
  );
  const key = accepted.portal_key;
  return withStoreLock(() => {
    const store = loadStore();
    const evidenceSha256 = registrationEvidenceDigest(accepted);
    const existing = store[key];
    if (existing) {
      if (existing.email === normalizedEmail && existing.password === stagedPassword &&
          existing.registration_evidence_sha256 === evidenceSha256) {
        return {
          committed: true,
          portal_host: key,
          accepted_at: accepted.accepted_at,
          created_at: existing.created_at,
          updated_at: existing.updated_at,
        };
      }
      throw new Error(
        'Exact-host credentials already exist; refusing overwrite, recovery, or password replacement',
      );
    }
    const now   = new Date().toISOString();
    store[key] = {
      email: normalizedEmail,
      password: stagedPassword,
      created_at: now,
      updated_at: now,
      registration_accepted_at: accepted.accepted_at,
      registration_evidence_sha256: evidenceSha256,
    };
    saveStore(store);
    return {
      committed: true,
      portal_host: key,
      accepted_at: accepted.accepted_at,
      created_at: store[key].created_at,
      updated_at: now,
    };
  });
}

/**
 * One-time maintenance move: re-key an existing stored credential (e.g. a
 * bare-host entry that turns out to belong to one tenant of a multi-tenant
 * host) to its correct key. Never overwrites an existing destination entry
 * and never touches the stored password value. Secret-free: does not read or
 * print the password.
 */
export function rekeyPortalCredential(oldKey, newKey) {
  const fromKey = normalizePortalKey(oldKey);
  const toKey = normalizePortalKey(newKey);
  if (fromKey === toKey) throw new Error('Old and new portal credential keys must differ');
  return withStoreLock(() => {
    const store = loadStore();
    if (!Object.hasOwn(store, fromKey)) {
      throw new Error(`No stored credentials found for key: ${fromKey}`);
    }
    if (Object.hasOwn(store, toKey)) {
      throw new Error(`Refusing to overwrite existing credentials at key: ${toKey}`);
    }
    store[toKey] = {
      ...store[fromKey],
      rekeyed_from: fromKey,
      rekeyed_at: new Date().toISOString(),
    };
    delete store[fromKey];
    saveStore(store);
    return { rekeyed: true, from: fromKey, to: toKey };
  });
}

/**
 * Backward-compatible name. A fourth, exact-host acceptance-evidence argument
 * is now mandatory; three-argument callers fail closed instead of persisting a
 * password before the portal confirms account creation.
 */
export function upsertCredentials(host, email, password, evidence) {
  return commitAcceptedRegistrationCredentials(host, email, password, evidence);
}

function loadRegistrationObservationArgument(argument) {
  if (!String(argument ?? '').startsWith('@')) {
    throw new Error('Registration observation must be supplied as @file.json');
  }
  const file = resolve(process.cwd(), String(argument).slice(1));
  if (statSync(file).size > 1024 * 1024) {
    throw new Error('Registration observation file exceeds 1 MiB');
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Registration observation JSON is invalid: ${error.message}`);
  }
}

async function runCredentialStoreCli(argv) {
  if (argv[0] === '--rekey') {
    if (!argv[1] || !argv[2] || argv.length !== 3) {
      throw new Error('Usage: node credentials-store.mjs --rekey <old-key> <new-key-or-portal-url>');
    }
    const result = rekeyPortalCredential(argv[1], argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (argv[0] !== '--bind-registration' || !argv[1] || !argv[2] || argv.length !== 3) {
    throw new Error(
      'Usage: node credentials-store.mjs --bind-registration <role-id> @acceptance.json\n' +
      '       node credentials-store.mjs --rekey <old-key> <new-key-or-portal-url>',
    );
  }
  const roleId = String(argv[1]).trim();
  const evidence = loadRegistrationObservationArgument(argv[2]);
  const { mutateQueue } = await import('./queue-store.mjs');
  let result;
  mutateQueue((queue) => {
    const role = queue.roles.find((item) => item?.id === roleId);
    if (!role) throw new Error(`Unknown queued role: ${roleId}`);
    result = bindAcceptedRegistrationObservation(role, evidence, { queue });
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMainModule = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  runCredentialStoreCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
