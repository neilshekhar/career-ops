#!/usr/bin/env node

/**
 * Context-aware application action safety policy.
 *
 * "Apply" / "Apply now" can be an entry control on a verified job posting or
 * a final submission control inside an application. Callers must provide the
 * current phase; ambiguous or final-form actions fail closed.
 */

export const FINAL_APPLICATION_ACTION = /^(?:submit(?:\s+(?:(?:my|your|the)\s+)?application)?(?:\s+now)?|send\s+(?:(?:my|your|the)\s+)?application|confirm\s+and\s+submit|complete\s+and\s+submit|finish\s+and\s+submit|(?:finish|complete)\s+(?:(?:my|your|the)\s+)?application|apply(?:\s+now)?)$/i;
export const INITIAL_APPLICATION_ACTION = /^(apply|apply now|start application|begin application|start applying)$/i;
export const REGISTRATION_CONFIRM_ACTION = /^(register|sign\s*up|create\s+(?:an?\s+)?account|create\s+profile|get\s+started|join|continue|submit(?:\s+registration)?)$/i;

export function isFinalApplicationActionLabel(text) {
  return FINAL_APPLICATION_ACTION.test(String(text ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * A caller may treat an ambiguous action such as plain "Submit" as account
 * registration only when live page evidence distinguishes it from both login
 * and job-application forms. Missing/unknown evidence fails closed.
 */
export function isConclusiveRegistrationContext(evidence) {
  return evidence?.classification === 'registration-form'
    && evidence?.registrationIntentVisible === true
    && evidence?.identityFieldVisible === true
    && evidence?.passwordFieldVisible === true
    && evidence?.applicationFormVisible === false;
}

export function applicationActionDecision(text, {
  phase = 'unknown',
  postingVerified = false,
  destinationMatched = false,
  registrationEvidence = null,
  applicationSubmissionDetected = false,
} = {}) {
  const label = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!label) return { allowed: false, reason: 'empty action label' };

  // This signal is authoritative regardless of a stale/misclassified phase.
  if (applicationSubmissionDetected || phase === 'application-submit') {
    return { allowed: false, reason: 'final application submission is candidate-only' };
  }

  if (phase === 'posting-entry') {
    if (!postingVerified || !destinationMatched) {
      return { allowed: false, reason: 'posting liveness and destination match are required' };
    }
    return INITIAL_APPLICATION_ACTION.test(label)
      ? { allowed: true, kind: 'initial-application-navigation' }
      : { allowed: false, reason: 'not an initial application action' };
  }

  if (phase === 'registration') {
    // Job-specific final labels never become registration actions. Plain
    // "Submit" is the sole overlap and is allowed only with conclusive evidence.
    if (FINAL_APPLICATION_ACTION.test(label) && !/^submit$/i.test(label)) {
      return { allowed: false, reason: 'final application submission is candidate-only' };
    }
    if (!isConclusiveRegistrationContext(registrationEvidence)) {
      return { allowed: false, reason: 'conclusive account-registration evidence is required' };
    }
    return REGISTRATION_CONFIRM_ACTION.test(label)
      ? { allowed: true, kind: 'registration-confirmation' }
      : { allowed: false, reason: 'not an account-registration confirmation action' };
  }

  if (phase === 'form-navigation') {
    return { allowed: false, reason: 'use the explicit navigation allowlist' };
  }

  if (FINAL_APPLICATION_ACTION.test(label)) {
    return { allowed: false, reason: 'final application submission is candidate-only' };
  }
  return { allowed: false, reason: 'unknown application action context' };
}
