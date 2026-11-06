import type {
  AdversarialFinding,
  AdversarialReview,
  Commitment,
  ReviewsResponse,
  TrustPassport,
  VerificationReview,
} from "../types";

export function latestVerification(
  reviews: ReviewsResponse | null | undefined,
): VerificationReview | null {
  return reviews?.independent_reviews?.[0] ?? null;
}

export function latestAdversarial(
  reviews: ReviewsResponse | null | undefined,
): AdversarialReview | null {
  return reviews?.adversarial_reviews?.[0] ?? null;
}

export function criticalFindings(findings: AdversarialFinding[] | null | undefined) {
  return (findings ?? []).filter(
    (finding) => finding.severity.toUpperCase() === "CRITICAL",
  );
}

export function commitmentHealth(
  commitment: Commitment,
  passport: TrustPassport | null | undefined,
) {
  if (commitment.status === "INVALIDATED") return 0;
  if (commitment.status === "REJECTED") return 0.25;
  if (commitment.status === "EVIDENCE_PENDING") return 0.45;

  const summary = passport?.trust_summary;

  if (!summary) return commitment.status === "APPROVED" ? 0.9 : 0.6;
  if (summary.evidence_integrity === "COLLAPSED") return 0.1;

  let score = 0.45;

  if (summary.proof_state === "PASS") score += 0.12;
  if (summary.independent_review_state === "PASS") score += 0.14;
  if (summary.adversarial_review_state && summary.adversarial_review_state !== "NOT_RUN") {
    score += 0.08;
  }
  if (summary.evidence_integrity === "INTACT") score += 0.11;
  if (summary.human_approval_state === "APPROVE") score += 0.15;

  if (commitment.status === "APPROVED") score = Math.max(score, 0.92);

  return Math.min(score, 1);
}

export function approvalBlockers(
  commitment: Commitment,
  passport: TrustPassport | null | undefined,
) {
  const blockers: string[] = [];

  if (commitment.status === "INVALIDATED") {
    blockers.push("Commitment is invalidated and locked.");
    return blockers;
  }

  if (commitment.status === "APPROVED") return blockers;
  if (commitment.status === "REJECTED") {
    blockers.push("Commitment was rejected; a new decision is required.");
  }

  const summary = passport?.trust_summary;

  if (!summary) {
    blockers.push("Trust summary is not available.");
    return blockers;
  }

  if (summary.evidence_integrity !== "INTACT") {
    blockers.push("Evidence integrity is not intact.");
  }

  if (summary.proof_state !== "PASS") {
    blockers.push("Deterministic proof evaluation has not passed.");
  }

  if (summary.independent_review_state !== "PASS") {
    blockers.push("Independent verification has not passed.");
  }

  if (!summary.adversarial_review_state || summary.adversarial_review_state === "NOT_RUN") {
    blockers.push("Adversarial review has not run.");
  }

  const adversarial = passport?.adversarial.history?.[0];

  if (adversarial && criticalFindings(adversarial.findings).length > 0) {
    blockers.push("Unresolved critical adversarial findings remain.");
  }

  if (summary.human_approval_state === "APPROVE") {
    blockers.push("Already approved.");
  }

  return blockers;
}

export function passportIntegrityScore(passport: TrustPassport | null | undefined) {
  if (!passport) return 0;

  const evidence = passport.evidence;

  if (!evidence.length) return 0;

  const passed = evidence.filter((item) => item.integrity === "PASS").length;
  return passed / evidence.length;
}

export function flattenFindings(
  reviews: Array<{ findings: AdversarialFinding[] }> | null | undefined,
) {
  return (reviews ?? []).flatMap((review) => review.findings ?? []);
}

export function stableCount<T>(items: T[], key: (item: T) => string) {
  return items.reduce<Record<string, number>>((accumulator, item) => {
    const value = key(item);
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}
