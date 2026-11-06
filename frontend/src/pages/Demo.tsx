import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  FolderLock,
  Loader2,
  Lock,
  PlayCircle,
  Radar,
  RotateCcw,
  ShieldCheck,
  Swords,
  UserCheck,
  Wand2,
} from "lucide-react";
import { api, ApiError, APPROVAL_TOKEN, APPROVER_ID } from "../api";
import { useData } from "../context/DataContext";
import {
  cx,
  formatDate,
  relativeTime,
  shortId,
  statusLabel,
} from "../lib/format";
import {
  Button,
  Card,
  CopyButton,
  ErrorState,
  Notice,
  PageHeader,
  ProgressRing,
  StatusBadge,
} from "../components/ui";
import type {
  CommitmentDetail,
  ReviewsResponse,
  TrustPassport,
  TrustScanResult,
} from "../types";

const STORAGE_KEY = "pactora.demo.commitmentId";

interface Feedback {
  tone: "success" | "danger" | "warning" | "info";
  text: string;
}

interface StageAction {
  id: string;
  label: string;
  icon: typeof FileCheck2;
  done: boolean;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

interface Stage {
  id: string;
  index: string;
  title: string;
  description: string;
  complete: boolean;
  active: boolean;
  locked: boolean;
  actions: StageAction[];
}

const SCENARIO = {
  title: "Customer Data Encryption",
  claim: "Customer data is encrypted at rest.",
  owner: "Security Engineering",
  acceptance_criteria:
    "Approved storage configuration demonstrates encryption enabled.",
  evidence: "environment=demo\nstorage_encryption=true\nalgorithm=AES-256\nscope=customer-data",
};

export function Demo() {
  const { refresh } = useData();
  const [commitmentId, setCommitmentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitmentDetail | null>(null);
  const [passport, setPassport] = useState<TrustPassport | null>(null);
  const [reviewSet, setReviewSet] = useState<ReviewsResponse | null>(null);
  const [scan, setScan] = useState<TrustScanResult | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async (id: string) => {
    const [nextDetail, nextPassport, nextReviews] = await Promise.all([
      api.getCommitment(id),
      api.trustPassport(id),
      api.reviews(id),
    ]);

    setDetail(nextDetail);
    setPassport(nextPassport);
    setReviewSet(nextReviews);
    setLoadError(null);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    if (!stored) return;

    setCommitmentId(stored);
    void reload(stored).catch((caught) => {
      setLoadError(
        caught instanceof ApiError
          ? caught.message
          : "The saved demonstration could not be loaded.",
      );
      window.localStorage.removeItem(STORAGE_KEY);
      setCommitmentId(null);
    });
  }, [reload]);

  const execute = async (
    key: string,
    action: () => Promise<Feedback>,
  ) => {
    setBusy(key);
    setFeedback(null);

    try {
      const message = await action();

      if (commitmentId) {
        await reload(commitmentId);
        await refresh();
      }

      setFeedback(message);
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "The demonstration step failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const createCommitment = () =>
    execute("create", async () => {
      const result = await api.createCommitment(SCENARIO);
      window.localStorage.setItem(STORAGE_KEY, result.commitment_id);
      setCommitmentId(result.commitment_id);
      setDetail(null);
      setPassport(null);
      setReviewSet(null);
      setScan(null);
      setBlockedMessage(null);
      await reload(result.commitment_id);
      await refresh();
      return {
        tone: "success",
        text: `${result.commitment_id} created with status EVIDENCE_PENDING.`,
      };
    });

  const attachEvidence = () =>
    execute("evidence", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.attachEvidence(commitmentId, {
        filename: "encryption-config.txt",
        content: SCENARIO.evidence,
      });
      return {
        tone: "success",
        text: `${result.evidence_id} stored. SHA-256 fingerprint: ${result.sha256.slice(0, 20)}…`,
      };
    });

  const verifyIntegrity = () =>
    execute("verify", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.verifyEvidence(commitmentId);
      return {
        tone: result.evidence_integrity === "PASS" ? "success" : "danger",
        text: result.message,
      };
    });

  const evaluateProof = () =>
    execute("proof", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");

      if (!passport?.proof.configured_checks.length) {
        const evidence = detail?.evidence[0];

        if (!evidence) throw new Error("Attach evidence before configuring a proof check.");

        await api.createProofChecks(commitmentId, [
          {
            evidence_id: evidence.id,
            name: "Encryption enabled",
            operator: "contains",
            expected_value: "storage_encryption=true",
          },
        ]);
      }

      const result = await api.evaluate(commitmentId);
      return {
        tone: result.result === "PASS" ? "success" : result.result === "FAIL" ? "danger" : "warning",
        text: result.interpretation,
      };
    });

  const runIndependent = () =>
    execute("independent", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.independentReview(commitmentId);
      return {
        tone: result.result === "PASS" ? "success" : "danger",
        text: `Independent review ${result.review_id} returned ${result.result}. Semantic verification remains false.`,
      };
    });

  const runAdversary = () =>
    execute("adversary", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.adversarialReview(commitmentId);
      return {
        tone: result.result === "CHALLENGED" ? "danger" : "warning",
        text: `${result.review_id} returned ${result.result} with ${result.findings.length} findings.`,
      };
    });

  const approve = () =>
    execute("approve", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.approval(
        commitmentId,
        {
          approver_id: APPROVER_ID,
          decision: "APPROVE",
          reason: "Guided demonstration: all configured assurance gates passed.",
        },
        APPROVAL_TOKEN,
      );
      return {
        tone: "success",
        text: `${result.approval_id} recorded by ${result.approver_id}. Commitment status: ${result.status}.`,
      };
    });

  const tamper = () =>
    execute("tamper", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.demoTamper(commitmentId);
      return {
        tone: "warning",
        text: `Evidence file modified. Fingerprint changed from ${shortId(result.before_sha256, 14)} to ${shortId(result.after_sha256, 14)}.`,
      };
    });

  const scanTrust = () =>
    execute("scan", async () => {
      if (!commitmentId) throw new Error("Create the commitment first.");
      const result = await api.trustScan(commitmentId);
      setScan(result);
      return {
        tone: result.trust_status === "INTACT" ? "success" : "danger",
        text: `${result.message} Affected commitments: ${result.affected_commitments.length}.`,
      };
    });

  const attemptBlockedEvidence = async () => {
    if (!commitmentId) return;

    setBusy("blocked");
    setFeedback(null);

    try {
      await api.attachEvidence(commitmentId, {
        filename: "late-evidence.txt",
        content: "storage_encryption=true",
      });
      setBlockedMessage(null);
      setFeedback({
        tone: "warning",
        text: "The backend accepted evidence, which means the commitment was not locked. Run the sentinel scan first.",
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setBlockedMessage(caught.message);
        setFeedback({ tone: "success", text: caught.message });
      } else {
        setFeedback({ tone: "danger", text: "Unexpected attachment failure." });
      }
    } finally {
      await reload(commitmentId);
      await refresh();
      setBusy(null);
    }
  };

  const reset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setCommitmentId(null);
    setDetail(null);
    setPassport(null);
    setReviewSet(null);
    setScan(null);
    setBlockedMessage(null);
    setFeedback(null);
    setLoadError(null);
  };

  const state = useMemo(() => {
    const created = Boolean(commitmentId && detail);
    const evidence = Boolean(detail?.evidence.length);
    const verified = Boolean(
      passport?.audit_trail.some(
        (event) =>
          event.event_type === "EVIDENCE_INTEGRITY_CHECK" &&
          typeof event.details === "object" &&
          event.details !== null &&
          (event.details as { all_pass?: boolean }).all_pass === true,
      ),
    );
    const proof = passport?.proof.latest_result === "PASS";
    const independent = passport?.verification.latest_result === "PASS";
    const challenged = Boolean(passport?.adversarial.latest_result);
    const approved = passport?.approval.latest_decision === "APPROVE";
    const tampered = Boolean(
      passport?.audit_trail.some((event) => event.event_type === "DEMO_EVIDENCE_TAMPERED"),
    );
    const monitored = Boolean(
      passport?.audit_trail.some((event) => event.event_type === "TRUST_COLLAPSE_DETECTED"),
    );
    const invalidated = detail?.commitment.status === "INVALIDATED";
    const locked = Boolean(blockedMessage);

    return {
      created,
      evidence,
      verified,
      proof,
      independent,
      challenged,
      approved,
      tampered,
      monitored,
      invalidated,
      locked,
    };
  }, [blockedMessage, commitmentId, detail, passport]);

  const completed = [
    state.created,
    state.evidence,
    state.verified && state.proof && state.independent,
    state.challenged,
    state.approved,
    state.monitored,
    state.locked,
  ].filter(Boolean).length;

  const stages: Stage[] = [
    {
      id: "create",
      index: "01",
      title: "Create the commitment",
      description:
        "State the business claim and the acceptance criteria that will govern verification. PACTORA records the declaration before any evidence exists.",
      complete: state.created,
      active: !state.created,
      locked: false,
      actions: [
        {
          id: "create",
          label: state.created ? "Commitment created" : "Create commitment",
          icon: FileCheck2,
          done: state.created,
          disabled: state.created,
          loading: busy === "create",
          onClick: createCommitment,
        },
      ],
    },
    {
      id: "evidence",
      index: "02",
      title: "Attach evidence",
      description:
        "Store the storage configuration artifact. PACTORA writes it under a generated identifier and records a SHA-256 fingerprint.",
      complete: state.evidence,
      active: state.created && !state.evidence,
      locked: !state.created,
      actions: [
        {
          id: "evidence",
          label: state.evidence ? "Evidence attached" : "Attach evidence",
          icon: FolderLock,
          done: state.evidence,
          disabled: !state.created || state.evidence || state.invalidated,
          loading: busy === "evidence",
          onClick: attachEvidence,
        },
      ],
    },
    {
      id: "verify",
      index: "03",
      title: "Verify the proof",
      description:
        "Run file integrity, a deterministic acceptance check and an independent recheck. Each is a separate gate with a separate record.",
      complete: state.verified && state.proof && state.independent,
      active: state.evidence && !(state.verified && state.proof && state.independent),
      locked: !state.evidence,
      actions: [
        {
          id: "verify",
          label: state.verified ? "Integrity verified" : "Verify integrity",
          icon: ShieldCheck,
          done: state.verified,
          disabled: !state.evidence || state.invalidated,
          loading: busy === "verify",
          onClick: verifyIntegrity,
        },
        {
          id: "proof",
          label: state.proof ? "Proof passed" : "Evaluate proof",
          icon: Wand2,
          done: state.proof,
          disabled: !state.evidence || state.invalidated,
          loading: busy === "proof",
          onClick: evaluateProof,
        },
        {
          id: "independent",
          label: state.independent ? "Review passed" : "Run independent review",
          icon: CheckCircle2,
          done: state.independent,
          disabled: !state.proof || state.invalidated,
          loading: busy === "independent",
          onClick: runIndependent,
        },
      ],
    },
    {
      id: "challenge",
      index: "04",
      title: "Challenge the evidence",
      description:
        "ADVERSARY surfaces weak evidence, missing corroboration and the semantic limits of the claim. The findings are recorded, not hidden.",
      complete: state.challenged,
      active: state.proof && !state.challenged,
      locked: !state.proof,
      actions: [
        {
          id: "adversary",
          label: state.challenged ? "Challenge recorded" : "Run ADVERSARY",
          icon: Swords,
          done: state.challenged,
          disabled: !state.proof || state.invalidated,
          loading: busy === "adversary",
          onClick: runAdversary,
        },
      ],
    },
    {
      id: "approve",
      index: "05",
      title: "Record human approval",
      description:
        "An authorized approver makes the accountable decision. The backend re-checks evidence integrity and review freshness at this exact moment.",
      complete: state.approved,
      active: state.challenged && !state.approved,
      locked: !state.challenged,
      actions: [
        {
          id: "approve",
          label: state.approved ? "Human approved" : "Approve as security.manager",
          icon: UserCheck,
          done: state.approved,
          disabled: !state.challenged || state.approved || state.invalidated,
          loading: busy === "approve",
          onClick: approve,
        },
      ],
    },
    {
      id: "monitor",
      index: "06",
      title: "Break trust, then detect it",
      description:
        "A real local demo exercise modifies the stored evidence bytes. SENTINEL then recomputes fingerprints and collapses trust when the commitment no longer matches its proof.",
      complete: state.monitored,
      active: state.approved && !state.monitored,
      locked: !state.approved,
      actions: [
        {
          id: "tamper",
          label: state.tampered ? "Evidence modified" : "Simulate evidence tampering",
          icon: CircleAlert,
          done: state.tampered,
          disabled: !state.approved || state.tampered,
          loading: busy === "tamper",
          onClick: tamper,
        },
        {
          id: "scan",
          label: state.monitored ? "Collapse detected" : "Run SENTINEL scan",
          icon: Radar,
          done: state.monitored,
          disabled: !state.tampered || state.monitored,
          loading: busy === "scan",
          onClick: scanTrust,
        },
      ],
    },
    {
      id: "trust",
      index: "07",
      title: "Inspect the collapsed passport",
      description:
        "The Trust Passport now reports collapsed evidence, a locked commitment and blocked re-attestation. This is the failure experience: visible, explainable and auditable.",
      complete: state.locked,
      active: state.monitored && !state.locked,
      locked: !state.monitored,
      actions: [
        {
          id: "blocked",
          label: state.locked ? "Attachment blocked" : "Attempt new evidence",
          icon: Lock,
          done: state.locked,
          disabled: !state.monitored || state.locked,
          loading: busy === "blocked",
          onClick: () => void attemptBlockedEvidence(),
        },
      ],
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Guided Demonstration"
        title="One commitment. One complete story."
        description="Create a real commitment, attach real evidence, run real backend reviews, approve it as a human, then break the evidence and watch trust collapse."
        actions={
          <Button variant="ghost" icon={RotateCcw} onClick={reset}>
            Start over
          </Button>
        }
      />

      {loadError ? <ErrorState message={loadError} /> : null}

      <section className="demo-scenario">
        <div>
          <div className="hero-kicker">
            <span className="hero-pulse" />
            Track 01 · Best Business Workflow
          </div>
          <h2>{SCENARIO.title}</h2>
          <blockquote>“{SCENARIO.claim}”</blockquote>
          <p>{SCENARIO.acceptance_criteria}</p>
          <div className="demo-scenario-meta">
            <span>Owner · {SCENARIO.owner}</span>
            <span>Claim semantic verification · false</span>
          </div>
        </div>
        <div className="demo-progress">
          <ProgressRing
            value={completed / 7}
            size={142}
            stroke={10}
            tone={
              state.invalidated
                ? "danger"
                : completed === 7
                  ? "success"
                  : "warning"
            }
            label={`${completed}/7`}
            sublabel="stages complete"
          />
          <div className="demo-progress-copy">
            <strong>
              {state.invalidated
                ? "Trust collapsed, as designed"
                : completed === 7
                  ? "Demonstration complete"
                  : "Demonstration in progress"}
            </strong>
            <span>
              {state.invalidated
                ? "The failure is visible, explainable and preserved in the audit trail."
                : "Every step writes a real record to the local PACTORA backend."}
            </span>
          </div>
        </div>
      </section>

      {feedback ? (
        <Notice tone={feedback.tone}>{feedback.text}</Notice>
      ) : null}

      {scan ? (
        <Card className="demo-scan">
          <div className="demo-scan-head">
            <Radar size={18} />
            <div>
              <strong>SENTINEL trust scan</strong>
              <span>{scan.message}</span>
            </div>
            <StatusBadge status={scan.trust_status} label={statusLabel(scan.trust_status)} />
          </div>
          <div className="demo-scan-grid">
            <div>
              <span>Evidence records</span>
              <strong>{scan.evidence_count}</strong>
            </div>
            <div>
              <span>Failed evidence</span>
              <strong className="text-danger">{scan.failed_evidence_count}</strong>
            </div>
            <div>
              <span>Affected commitments</span>
              <strong className="text-danger">{scan.affected_commitments.length}</strong>
            </div>
            <div>
              <span>Commitment status</span>
              <strong>{scan.commitment_status}</strong>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="demo-grid">
        <div className="demo-stages">
          {stages.map((stage) => (
            <article
              key={stage.id}
              className={cx(
                "demo-stage",
                stage.complete && "demo-stage-complete",
                stage.active && "demo-stage-active",
                stage.locked && "demo-stage-locked",
              )}
            >
              <div className="demo-stage-rail">
                <span className="demo-stage-index">
                  {stage.complete ? <CheckCircle2 size={17} /> : stage.index}
                </span>
              </div>
              <div className="demo-stage-body">
                <div className="demo-stage-head">
                  <div>
                    <h3>{stage.title}</h3>
                    <p>{stage.description}</p>
                  </div>
                  <StatusBadge
                    status={
                      stage.complete
                        ? "COMPLETE"
                        : stage.active
                          ? "ACTIVE"
                          : "LOCKED"
                    }
                    label={
                      stage.complete
                        ? "Complete"
                        : stage.active
                          ? "Ready"
                          : "Locked"
                    }
                    tone={stage.complete ? "success" : stage.active ? "info" : "neutral"}
                  />
                </div>

                {stage.id === "trust" && state.locked ? (
                  <div className="demo-blocked">
                    <Lock size={17} />
                    <div>
                      <strong>New evidence is blocked</strong>
                      <p>{blockedMessage}</p>
                    </div>
                  </div>
                ) : null}

                <div className="demo-actions">
                  {stage.actions.map((action) => (
                    <button
                      key={action.id}
                      className={cx(
                        "demo-action",
                        action.done && "demo-action-done",
                      )}
                      onClick={action.onClick}
                      disabled={action.disabled || action.loading}
                    >
                      {action.loading ? (
                        <Loader2 size={16} className="spin" />
                      ) : action.done ? (
                        <CheckCircle2 size={16} />
                      ) : (
                        <action.icon size={16} />
                      )}
                      <span>{action.label}</span>
                      {action.done ? <span className="demo-action-check">recorded</span> : null}
                    </button>
                  ))}
                </div>

                {stage.id === "trust" ? (
                  <div className="demo-links">
                    {commitmentId ? (
                      <>
                        <Link to={`/commitments/${commitmentId}`} className="text-link">
                          Open commitment <ArrowRight size={14} />
                        </Link>
                        <Link to={`/passport/${commitmentId}`} className="text-link">
                          Open Trust Passport <BadgeCheck size={14} />
                        </Link>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <aside className="demo-side">
          <Card>
            <div className="section-heading">
              <div>
                <h2>Live record</h2>
                <p>Derived from the backend after every step.</p>
              </div>
            </div>

            {!commitmentId ? (
              <div className="compact-empty">
                <PlayCircle size={18} />
                <p>Start with stage 01 to create the demonstration commitment.</p>
              </div>
            ) : (
              <div className="demo-record">
                <div className="demo-record-head">
                  <div>
                    <strong>{detail?.commitment.title || SCENARIO.title}</strong>
                    <span className="mono">{commitmentId}</span>
                  </div>
                  <CopyButton value={commitmentId} label="" />
                </div>

                {detail ? (
                  <StatusBadge
                    status={detail.commitment.status}
                    label={statusLabel(detail.commitment.status)}
                  />
                ) : (
                  <StatusBadge status="EVIDENCE_PENDING" label="Loading" tone="neutral" />
                )}

                <div className="demo-state-grid">
                  <StateCell label="Evidence integrity" value={passport?.trust_summary.evidence_integrity || "—"} />
                  <StateCell label="Proof" value={passport?.trust_summary.proof_state || "—"} />
                  <StateCell label="Independent" value={passport?.trust_summary.independent_review_state || "—"} />
                  <StateCell label="Adversarial" value={passport?.trust_summary.adversarial_review_state || "—"} />
                  <StateCell label="Human approval" value={passport?.trust_summary.human_approval_state || "—"} />
                  <StateCell label="Semantic truth" value="FALSE" forceWarning />
                </div>

                <div className="demo-record-facts">
                  <div>
                    <span>Evidence records</span>
                    <strong>{detail?.evidence.length ?? 0}</strong>
                  </div>
                  <div>
                    <span>Proof checks</span>
                    <strong>{passport?.proof.configured_checks.length ?? 0}</strong>
                  </div>
                  <div>
                    <span>Reviews</span>
                    <strong>
                      {(reviewSet?.independent_reviews.length ?? 0) +
                        (reviewSet?.adversarial_reviews.length ?? 0)}
                    </strong>
                  </div>
                  <div>
                    <span>Last event</span>
                    <strong>
                      {passport?.audit_trail.length
                        ? relativeTime(
                            passport.audit_trail[passport.audit_trail.length - 1].created_at,
                          )
                        : "—"}
                    </strong>
                  </div>
                </div>

                {passport ? (
                  <div className="demo-passport-id">
                    <span>Assurance snapshot</span>
                    <code>{passport.passport_id}</code>
                    <span>{formatDate(passport.generated_at)}</span>
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          <Card>
            <div className="section-heading">
              <div>
                <h2>What this demonstrates</h2>
                <p>The full lifecycle, including the failure path.</p>
              </div>
            </div>
            <ul className="demo-bullets">
              <li>Evidence attachment with a real SHA-256 fingerprint.</li>
              <li>File integrity verification that does not claim semantic truth.</li>
              <li>Real VERIFIER and ADVERSARY backend records.</li>
              <li>Human approval gated by current evidence and review freshness.</li>
              <li>Byte-level evidence tampering and SENTINEL trust collapse.</li>
              <li>Blocked re-attestation after invalidation.</li>
              <li>Audit trail and Trust Passport collapse.</li>
            </ul>
          </Card>

          <Card className="demo-honesty">
            <ShieldCheck size={18} />
            <div>
              <strong>No fabricated certainty</strong>
              <p>
                PACTORA proves that a specific file has not changed and that
                configured checks passed. It does not prove the business claim is
                universally true. The passport says so explicitly.
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function StateCell({
  label,
  value,
  forceWarning,
}: {
  label: string;
  value: string;
  forceWarning?: boolean;
}) {
  const normalized = value.toUpperCase();
  const tone = forceWarning
    ? "warning"
    : normalized === "PASS" || normalized === "INTACT" || normalized === "APPROVE"
      ? "success"
      : normalized === "FAILED" || normalized === "COLLAPSED" || normalized === "CHALLENGED"
        ? "danger"
        : "neutral";

  return (
    <div className={cx("demo-state-cell", `state-${tone}`)}>
      <span>{label}</span>
      <strong>{value === "—" ? "—" : statusLabel(value)}</strong>
    </div>
  );
}
