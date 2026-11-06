import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  FolderLock,
  Plus,
  ScanLine,
  ShieldCheck,
  Swords,
  UserCheck,
  Wand2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError, APPROVAL_TOKEN, APPROVER_ID } from "../api";
import { useData } from "../context/DataContext";
import {
  approvalBlockers,
  criticalFindings,
  latestAdversarial,
  latestVerification,
} from "../lib/derive";
import {
  cx,
  formatDate,
  relativeTime,
  shortId,
  statusLabel,
  statusTone,
} from "../lib/format";
import {
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  FormField,
  KeyValue,
  Modal,
  Notice,
  SectionHeading,
  Select,
  SkeletonPage,
  StatusBadge,
  Tabs,
  TextArea,
  TextInput,
} from "../components/ui";
import type {
  AdversarialFinding,
  AuditEvent,
  ProofCheck,
  TrustScanResult,
} from "../types";

type TabId = "overview" | "evidence" | "reviews" | "audit";

interface Feedback {
  tone: "success" | "danger" | "warning" | "info";
  title: string;
  text: string;
}

function eventIcon(eventType: string) {
  if (eventType.includes("APPROVAL")) return UserCheck;
  if (eventType.includes("ADVERSARIAL")) return Swords;
  if (eventType.includes("TRUST_COLLAPSE") || eventType.includes("TAMPER")) return CircleAlert;
  if (eventType.includes("INTEGRITY") || eventType.includes("REVIEW")) return ShieldCheck;
  if (eventType.includes("EVIDENCE")) return FolderLock;
  return Activity;
}

function findingTone(severity: string) {
  if (severity === "CRITICAL") return "danger";
  if (severity === "WARNING") return "warning";
  return "info";
}

export function CommitmentDetail() {
  const { id = "" } = useParams();
  const {
    commitments,
    details,
    passports,
    reviews,
    audits,
    loading,
    error,
    refresh,
  } = useData();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [scanResult, setScanResult] = useState<TrustScanResult | null>(null);

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceForm, setEvidenceForm] = useState({
    filename: "encryption-config.txt",
    content: "environment=demo\nstorage_encryption=true\nalgorithm=AES-256",
  });
  const [proofOpen, setProofOpen] = useState(false);
  const [proofForm, setProofForm] = useState({
    name: "Encryption enabled",
    operator: "contains",
    expected_value: "storage_encryption=true",
  });
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalForm, setApprovalForm] = useState({
    approver_id: APPROVER_ID,
    reason: "All configured assurance gates passed.",
    token: APPROVAL_TOKEN,
    decision: "APPROVE" as "APPROVE" | "REJECT",
  });
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

  const commitment = commitments.find((item) => item.id === id);
  const detail = details[id];
  const passport = passports[id];
  const reviewSet = reviews[id];
  const audit = audits[id];
  const evidence = detail?.evidence ?? [];
  const proofChecks: ProofCheck[] = passport?.proof.configured_checks ?? [];
  const latestProof = passport?.proof.history?.[0] ?? null;
  const verification = latestVerification(reviewSet);
  const adversarial = latestAdversarial(reviewSet);
  const blockers = commitment ? approvalBlockers(commitment, passport) : [];
  const critical = criticalFindings(adversarial?.findings);

  const health = useMemo(() => {
    if (!passport) return "UNKNOWN";
    return passport.trust_summary.evidence_integrity;
  }, [passport]);

  const canAttach =
    commitment?.status !== "APPROVED" && commitment?.status !== "INVALIDATED";

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFeedback(null);

    try {
      await action();
    } catch (caught) {
      setFeedback({
        tone: "danger",
        title: "Action failed",
        text: caught instanceof ApiError ? caught.message : "Unexpected backend error.",
      });
    } finally {
      setBusy(null);
    }
  };

  const verify = () =>
    run("verify", async () => {
      const result = await api.verifyEvidence(id);
      await refresh();
      setFeedback({
        tone: result.evidence_integrity === "PASS" ? "success" : "danger",
        title:
          result.evidence_integrity === "PASS"
            ? "Evidence integrity passed"
            : "Evidence integrity failed",
        text: result.message,
      });
    });

  const evaluate = () =>
    run("evaluate", async () => {
      const result = await api.evaluate(id);
      await refresh();
      setFeedback({
        tone: result.result === "PASS" ? "success" : result.result === "FAIL" ? "danger" : "warning",
        title: `Proof evaluation ${statusLabel(result.result)}`,
        text: result.interpretation,
      });
    });

  const runVerifier = () =>
    run("verifier", async () => {
      const result = await api.independentReview(id);
      await refresh();
      setFeedback({
        tone: result.result === "PASS" ? "success" : "danger",
        title: `Independent review ${statusLabel(result.result)}`,
        text: `Review ${result.review_id} was recorded. Claim semantic verification remains false.`,
      });
    });

  const runAdversary = () =>
    run("adversary", async () => {
      const result = await api.adversarialReview(id);
      await refresh();
      setFeedback({
        tone: result.result === "CHALLENGED" ? "danger" : "warning",
        title: `Adversarial review ${statusLabel(result.result)}`,
        text: `${result.findings.length} findings recorded. Review ${result.review_id}.`,
      });
    });

  const runScan = () =>
    run("scan", async () => {
      const result = await api.trustScan(id);
      setScanResult(result);
      await refresh();
      setFeedback({
        tone: result.trust_status === "INTACT" ? "success" : "danger",
        title:
          result.trust_status === "INTACT"
            ? "Sentinel scan: trust intact"
            : "Sentinel scan: trust collapsed",
        text: result.message,
      });
    });

  const runTamper = () =>
    run("tamper", async () => {
      const result = await api.demoTamper(id);
      await refresh();
      setFeedback({
        tone: "warning",
        title: "Demo exercise: evidence was modified",
        text: `${result.message} Fingerprint changed from ${shortId(result.before_sha256, 12)} to ${shortId(result.after_sha256, 12)}.`,
      });
    });

  const submitEvidence = async (event: FormEvent) => {
    event.preventDefault();
    setModalBusy(true);
    setModalError(null);

    try {
      const result = await api.attachEvidence(id, evidenceForm);
      await refresh();
      setEvidenceOpen(false);
      setFeedback({
        tone: "success",
        title: "Evidence stored",
        text: `${result.evidence_id} fingerprinted with SHA-256 ${result.sha256.slice(0, 16)}…`,
      });
    } catch (caught) {
      setModalError(caught instanceof ApiError ? caught.message : "Evidence attachment failed.");
    } finally {
      setModalBusy(false);
    }
  };

  const submitProof = async (event: FormEvent) => {
    event.preventDefault();
    setModalBusy(true);
    setModalError(null);

    if (!evidence[0]) {
      setModalError("Attach evidence before configuring proof checks.");
      setModalBusy(false);
      return;
    }

    try {
      await api.createProofChecks(id, [
        {
          evidence_id: evidence[0].id,
          name: proofForm.name,
          operator: proofForm.operator as "contains" | "equals",
          expected_value: proofForm.expected_value,
        },
      ]);
      await refresh();
      setProofOpen(false);
      setFeedback({
        tone: "success",
        title: "Proof check configured",
        text: "The deterministic check is now part of the acceptance criteria. Run evaluation to record a result.",
      });
    } catch (caught) {
      setModalError(caught instanceof ApiError ? caught.message : "Proof check creation failed.");
    } finally {
      setModalBusy(false);
    }
  };

  const submitApproval = async (event: FormEvent) => {
    event.preventDefault();
    setModalBusy(true);
    setModalError(null);

    try {
      const result = await api.approval(
        id,
        {
          approver_id: approvalForm.approver_id,
          decision: approvalForm.decision,
          reason: approvalForm.reason,
        },
        approvalForm.token,
      );
      await refresh();
      setApprovalOpen(false);
      setFeedback({
        tone: result.decision === "APPROVE" ? "success" : "warning",
        title: `Human decision: ${result.decision}`,
        text: `Approval ${result.approval_id} recorded by ${result.approver_id}. Commitment status is now ${result.status}.`,
      });
    } catch (caught) {
      setModalError(caught instanceof ApiError ? caught.message : "Approval failed.");
    } finally {
      setModalBusy(false);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  if (!commitment) {
    return (
      <EmptyState
        icon={FileCheck2}
        title="Commitment not found"
        description="This commitment may not exist, or may be outside your current read scope."
        action={
          <Button variant="secondary" onClick={() => navigate("/commitments")}>
            Back to commitments
          </Button>
        }
      />
    );
  }

  return (
    <div className="page-stack">
      <div className="detail-topline">
        <Link to="/commitments" className="back-link">
          <ArrowLeft size={15} /> Commitment Center
        </Link>
        <span className="subtle mono">{commitment.id}</span>
      </div>

      <section className="detail-hero">
        <div>
          <div className="detail-kicker">
            <StatusBadge
              status={commitment.status}
              label={statusLabel(commitment.status)}
            />
            <span>{commitment.owner}</span>
            <span>Created {formatDate(commitment.created_at)}</span>
          </div>
          <h1>{commitment.title}</h1>
          <p className="detail-claim">{commitment.claim}</p>
          <div className="detail-criteria">
            <span>Acceptance criteria</span>
            <p>{commitment.acceptance_criteria}</p>
          </div>
        </div>

        <div className="detail-score">
          <div className="score-label">Evidence integrity</div>
          <div
            className={cx(
              "score-value",
              health === "INTACT"
                ? "text-success"
                : health === "COLLAPSED"
                  ? "text-danger"
                  : "subtle",
            )}
          >
            {health === "INTACT"
              ? "Intact"
              : health === "COLLAPSED"
                ? "Collapsed"
                : "Not verified"}
          </div>
          <div className="score-detail">
            {evidence.length} evidence records · {proofChecks.length} checks
          </div>
          <div className="score-note">
            Semantic claim verification: <strong>false</strong>
          </div>
        </div>
      </section>

      <div className="action-bar">
        <Button
          icon={ShieldCheck}
          onClick={verify}
          loading={busy === "verify"}
          disabled={evidence.length === 0}
        >
          Verify integrity
        </Button>
        <Button
          icon={FolderLock}
          onClick={() => {
            setModalError(null);
            setEvidenceOpen(true);
          }}
          disabled={!canAttach}
        >
          Attach evidence
        </Button>
        <Button
          icon={FileCheck2}
          onClick={() => {
            setModalError(null);
            setProofOpen(true);
          }}
          disabled={evidence.length === 0 || commitment.status === "INVALIDATED"}
        >
          Add proof check
        </Button>
        <Button icon={Wand2} onClick={evaluate} loading={busy === "evaluate"}>
          Evaluate proof
        </Button>
        <Button icon={ScanLine} onClick={runScan} loading={busy === "scan"}>
          Trust scan
        </Button>
        <Button
          icon={UserCheck}
          variant={commitment.status === "APPROVED" ? "secondary" : "primary"}
          onClick={() => {
            setModalError(null);
            setApprovalOpen(true);
          }}
          disabled={commitment.status === "INVALIDATED"}
        >
          Human decision
        </Button>
        <Button
          icon={CircleAlert}
          variant="ghost"
          onClick={runTamper}
          loading={busy === "tamper"}
          disabled={!evidence.length}
          className="demo-danger-button"
        >
          Simulate tamper
        </Button>
      </div>

      {feedback ? (
        <Notice tone={feedback.tone} title={feedback.title}>
          {feedback.text}
        </Notice>
      ) : null}

      {scanResult ? (
        <Card className="scan-result">
          <SectionHeading
            title="Sentinel trust scan"
            subtitle={scanResult.message}
            action={
              <StatusBadge
                status={scanResult.trust_status}
                label={statusLabel(scanResult.trust_status)}
              />
            }
          />
          <div className="scan-results">
            {scanResult.results.map((result) => (
              <div className="scan-row" key={result.evidence_id}>
                <StatusBadge status={result.integrity} label={result.integrity} dot={false} />
                <strong>{result.filename}</strong>
                <span className="mono subtle">{shortId(result.evidence_id, 16)}</span>
                <span className="scan-reason">{result.reason}</span>
              </div>
            ))}
          </div>
          {scanResult.affected_commitments.length > 1 ? (
            <div className="scan-affected">
              <span>Trust collapse propagated to {scanResult.affected_commitments.length} commitments:</span>
              {scanResult.affected_commitments.map((affected) => (
                <Link key={affected} to={`/commitments/${affected}`} className="inline-link">
                  {shortId(affected, 18)}
                </Link>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Assurance overview" },
          { id: "evidence", label: "Evidence", count: evidence.length },
          { id: "reviews", label: "Reviews", count: (reviewSet?.independent_reviews.length ?? 0) + (reviewSet?.adversarial_reviews.length ?? 0) },
          { id: "audit", label: "Audit trail", count: audit?.length ?? 0 },
        ]}
      />

      {tab === "overview" ? (
        <div className="detail-grid">
          <div className="detail-main">
            <Card>
              <SectionHeading
                title="Assurance gates"
                subtitle="A commitment may only be approved when every gate passes against current evidence."
              />
              <div className="gate-list">
                <GateRow
                  index="01"
                  title="Evidence integrity"
                  description="Stored files match their recorded SHA-256 fingerprints."
                  status={passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE"}
                  action={
                    <Button size="sm" variant="ghost" onClick={verify} loading={busy === "verify"}>
                      Verify
                    </Button>
                  }
                />
                <GateRow
                  index="02"
                  title="Deterministic proof"
                  description="Configured acceptance checks were evaluated against intact evidence."
                  status={latestProof?.result || "NOT_RUN"}
                  action={
                    <Button size="sm" variant="ghost" onClick={evaluate} loading={busy === "evaluate"}>
                      Evaluate
                    </Button>
                  }
                />
                <GateRow
                  index="03"
                  title="Independent verification"
                  description="A separate reviewer re-ran the configured checks without trusting saved results."
                  status={verification?.result || "NOT_RUN"}
                  action={
                    <Button size="sm" variant="ghost" onClick={runVerifier} loading={busy === "verifier"}>
                      Run review
                    </Button>
                  }
                />
                <GateRow
                  index="04"
                  title="Adversarial review"
                  description="Known weaknesses and limitations are surfaced before human approval."
                  status={adversarial?.result || "NOT_RUN"}
                  action={
                    <Button size="sm" variant="ghost" onClick={runAdversary} loading={busy === "adversary"}>
                      Challenge
                    </Button>
                  }
                />
                <GateRow
                  index="05"
                  title="Human approval"
                  description="An authorized approver records the final accountable decision."
                  status={passport?.trust_summary.human_approval_state || "PENDING"}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setApprovalOpen(true)}>
                      Decide
                    </Button>
                  }
                />
              </div>
              {blockers.length ? (
                <Notice tone="warning" title="Approval is currently blocked">
                  <ul className="tight-list">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
            </Card>

            <Card>
              <SectionHeading
                title="Configured proof checks"
                subtitle="Deterministic, file-bound checks. These do not establish semantic truth."
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Plus}
                    onClick={() => setProofOpen(true)}
                    disabled={evidence.length === 0 || commitment.status === "INVALIDATED"}
                  >
                    Add check
                  </Button>
                }
              />
              {proofChecks.length === 0 ? (
                <div className="compact-empty">
                  <FileCheck2 size={18} />
                  <p>No proof checks are configured. Add explicit acceptance criteria before evaluation.</p>
                </div>
              ) : (
                <div className="check-list">
                  {proofChecks.map((check) => {
                    const result = latestProof?.details.find(
                      (item) => item.check_id === check.id,
                    );

                    return (
                      <div className="check-row" key={check.id}>
                        <div>
                          <strong>{check.name}</strong>
                          <span className="mono subtle">
                            {check.evidence_id} · {check.operator} “{check.expected_value}”
                          </span>
                        </div>
                        <StatusBadge
                          status={result?.outcome || "NOT_RUN"}
                          label={result ? statusLabel(result.outcome) : "Not evaluated"}
                        />
                        <p>{result?.reason || "Awaiting evaluation."}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card>
              <SectionHeading
                title="Adversarial findings"
                subtitle="Limitations recorded by the ADVERSARY review engine."
                action={
                  <Button size="sm" variant="secondary" icon={Swords} onClick={runAdversary} loading={busy === "adversary"}>
                    Re-challenge
                  </Button>
                }
              />
              {adversarial?.findings?.length ? (
                <div className="finding-list">
                  {adversarial.findings.map((finding: AdversarialFinding) => (
                    <FindingRow key={`${finding.code}-${finding.message}`} finding={finding} />
                  ))}
                </div>
              ) : (
                <div className="compact-empty">
                  <Swords size={18} />
                  <p>No adversarial review has been recorded for this commitment.</p>
                </div>
              )}
            </Card>
          </div>

          <div className="detail-side">
            <Card>
              <SectionHeading title="Trust passport" subtitle="Live assurance snapshot." />
              <div className="mini-passport">
                <div className="mini-passport-head">
                  <BadgeCheck size={20} />
                  <div>
                    <strong>{passport?.passport_id || "Not generated"}</strong>
                    <span>{passport ? formatDate(passport.generated_at) : "Open the passport view to generate"}</span>
                  </div>
                </div>
                <KeyValue label="Evidence" value={statusLabel(passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE")} />
                <KeyValue label="Proof" value={statusLabel(passport?.trust_summary.proof_state || "NOT_RUN")} />
                <KeyValue label="Independent" value={statusLabel(passport?.trust_summary.independent_review_state || "NOT_RUN")} />
                <KeyValue label="Adversarial" value={statusLabel(passport?.trust_summary.adversarial_review_state || "NOT_RUN")} />
                <KeyValue label="Approval" value={statusLabel(passport?.trust_summary.human_approval_state || "PENDING")} />
                <Link className="button button-secondary button-md full-width" to={`/passport/${commitment.id}`}>
                  <BadgeCheck size={15} />
                  <span>Open full passport</span>
                </Link>
              </div>
            </Card>

            <Card>
              <SectionHeading title="Latest signals" />
              <div className="signal-list">
                <SignalRow
                  icon={ShieldCheck}
                  label="Independent review"
                  value={verification ? statusLabel(verification.result) : "Not run"}
                  tone={statusTone(verification?.result || "NOT_RUN")}
                  detail={verification ? relativeTime(verification.created_at) : "—"}
                />
                <SignalRow
                  icon={Swords}
                  label="Adversarial review"
                  value={adversarial ? statusLabel(adversarial.result) : "Not run"}
                  tone={statusTone(adversarial?.result || "NOT_RUN")}
                  detail={critical.length ? `${critical.length} critical` : adversarial ? `${adversarial.findings.length} findings` : "—"}
                />
                <SignalRow
                  icon={ScanLine}
                  label="Evidence state"
                  value={statusLabel(passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE")}
                  tone={statusTone(passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE")}
                  detail={`${evidence.length} records`}
                />
                <SignalRow
                  icon={UserCheck}
                  label="Human decision"
                  value={statusLabel(passport?.trust_summary.human_approval_state || "PENDING")}
                  tone={statusTone(passport?.trust_summary.human_approval_state || "PENDING")}
                  detail={passport?.approval.approver_id || "Not appointed"}
                />
              </div>
            </Card>

            <Card>
              <SectionHeading title="Record identity" />
              <div className="identity-block">
                <span>Commitment ID</span>
                <div className="identity-value">
                  <code>{commitment.id}</code>
                  <CopyButton value={commitment.id} />
                </div>
                <span>Owner</span>
                <div className="identity-value">
                  <code>{commitment.owner}</code>
                </div>
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === "evidence" ? (
        <Card>
          <SectionHeading
            title="Evidence records"
            subtitle="Files are stored under generated identifiers. Displayed names are labels only."
            action={
              <Button
                variant="secondary"
                icon={FolderLock}
                onClick={() => setEvidenceOpen(true)}
                disabled={!canAttach}
              >
                Attach evidence
              </Button>
            }
          />
          {!canAttach ? (
            <Notice tone="warning">
              {commitment.status === "INVALIDATED"
                ? "Invalidated commitments are locked. New evidence cannot be attached until an authorized re-attestation workflow exists."
                : "Approved commitments are immutable. New evidence cannot be attached."}
            </Notice>
          ) : null}
          {evidence.length === 0 ? (
            <EmptyState
              icon={FolderLock}
              title="No evidence attached"
              description="Attach the artifact that supports this commitment. PACTORA will compute a SHA-256 fingerprint at storage time."
              action={
                <Button variant="primary" icon={FolderLock} onClick={() => setEvidenceOpen(true)}>
                  Attach first evidence
                </Button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Evidence</th>
                    <th>SHA-256</th>
                    <th>Integrity</th>
                    <th>Attached</th>
                    <th>Commitment</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.map((item) => {
                    const integrity =
                      passport?.evidence.find(
                        (candidate) => candidate.evidence_id === item.id,
                      )?.integrity || "UNKNOWN";

                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="table-primary">
                            <strong>{item.filename}</strong>
                            <span className="mono subtle">{item.id}</span>
                          </div>
                        </td>
                        <td>
                          <div className="hash-cell">
                            <code title={item.sha256}>{item.sha256}</code>
                            <CopyButton value={item.sha256} />
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={integrity} label={integrity === "PASS" ? "Verified" : integrity === "FAILED" ? "Failed" : integrity} />
                        </td>
                        <td>{formatDate(item.created_at)}</td>
                        <td className="mono subtle">{commitment.id}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "reviews" ? (
        <div className="review-grid">
          <Card>
            <SectionHeading
              title="Independent verification"
              subtitle="Deterministic recheck by a separate reviewer identity."
              action={
                <Button size="sm" variant="secondary" onClick={runVerifier} loading={busy === "verifier"}>
                  Run review
                </Button>
              }
            />
            {reviewSet?.independent_reviews.length ? (
              <div className="review-list">
                {reviewSet.independent_reviews.map((review) => (
                  <div className="review-card" key={review.review_id}>
                    <div className="review-head">
                      <StatusBadge status={review.result} label={statusLabel(review.result)} />
                      <span className="mono subtle">{review.review_id}</span>
                      <span className="subtle">{formatDate(review.created_at)}</span>
                    </div>
                    <p className="review-method">
                      Method: <strong>{review.details.method || "independent_deterministic_recheck"}</strong>
                    </p>
                    <div className="review-checks">
                      {(review.details.results ?? []).map((result) => (
                        <div key={`${review.review_id}-${result.check_id}`}>
                          <StatusBadge status={result.outcome} label={result.outcome} dot={false} />
                          <span className="mono subtle">{result.check_id}</span>
                          <span>{result.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="compact-empty">
                <ShieldCheck size={18} />
                <p>No independent reviews have been recorded.</p>
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading
              title="Adversarial intelligence"
              subtitle="Heuristic review, not autonomous semantic reasoning."
              action={
                <Button size="sm" variant="secondary" onClick={runAdversary} loading={busy === "adversary"}>
                  Challenge
                </Button>
              }
            />
            {reviewSet?.adversarial_reviews.length ? (
              <div className="review-list">
                {reviewSet.adversarial_reviews.map((review) => (
                  <div className="review-card" key={review.review_id}>
                    <div className="review-head">
                      <StatusBadge status={review.result} label={statusLabel(review.result)} />
                      <span className="mono subtle">{review.review_id}</span>
                      <span className="subtle">{formatDate(review.created_at)}</span>
                    </div>
                    <div className="finding-list compact">
                      {review.findings.map((finding) => (
                        <FindingRow
                          key={`${review.review_id}-${finding.code}-${finding.message}`}
                          finding={finding}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="compact-empty">
                <Swords size={18} />
                <p>No adversarial reviews have been recorded.</p>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "audit" ? (
        <Card>
          <SectionHeading
            title="Audit trail"
            subtitle="Append-only record of every commitment event. Actor and request metadata are preserved when supplied."
          />
          {audit?.length ? (
            <div className="audit-timeline">
              {[...audit].reverse().map((event: AuditEvent) => {
                const Icon = eventIcon(event.event_type);
                const details = event.details as Record<string, unknown> | null;

                return (
                  <div className="audit-row" key={event.id}>
                    <div className="audit-marker">
                      <Icon size={15} />
                    </div>
                    <div className="audit-body">
                      <div className="audit-head">
                        <strong>{statusLabel(event.event_type)}</strong>
                        <span>{formatDate(event.created_at)}</span>
                      </div>
                      <div className="audit-meta">
                        <span className="mono subtle">{shortId(event.id, 18)}</span>
                        {details && typeof details.request_id === "string" ? (
                          <span className="mono subtle">{details.request_id}</span>
                        ) : null}
                        {details && typeof details.actor === "object" && details.actor ? (
                          <span className="subtle">
                            {(details.actor as { name?: string }).name || "system"}
                          </span>
                        ) : null}
                      </div>
                      <pre className="audit-payload">
                        {JSON.stringify(event.details, null, 2)}
                      </pre>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="compact-empty">
              <Activity size={18} />
              <p>No audit events recorded.</p>
            </div>
          )}
        </Card>
      ) : null}

      <Modal
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        title="Attach evidence"
        description="The content is stored under a generated filename and hashed with SHA-256 immediately."
        wide
      >
        <form className="form-grid" onSubmit={submitEvidence}>
          <FormField label="Evidence label" hint="A human-readable label; it is not used as a filesystem path.">
            <TextInput
              value={evidenceForm.filename}
              onChange={(event) =>
                setEvidenceForm({ ...evidenceForm, filename: event.target.value })
              }
              minLength={1}
              maxLength={120}
              required
            />
          </FormField>
          <FormField label="Evidence content">
            <TextArea
              value={evidenceForm.content}
              onChange={(event) =>
                setEvidenceForm({ ...evidenceForm, content: event.target.value })
              }
              rows={7}
              required
            />
          </FormField>
          {modalError ? <div className="form-error" role="alert">{modalError}</div> : null}
          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setEvidenceOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon={FolderLock} loading={modalBusy}>
              Store and fingerprint
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={proofOpen}
        onClose={() => setProofOpen(false)}
        title="Add deterministic proof check"
        description="Checks run only against intact evidence. They validate a file condition, not the complete business claim."
        wide
      >
        <form className="form-grid" onSubmit={submitProof}>
          <FormField label="Check name">
            <TextInput
              value={proofForm.name}
              onChange={(event) => setProofForm({ ...proofForm, name: event.target.value })}
              minLength={3}
              maxLength={150}
              required
            />
          </FormField>
          <FormField label="Evidence">
            <Select value={evidence[0]?.id || ""} disabled>
              <option value={evidence[0]?.id || ""}>
                {evidence[0]?.filename || "No evidence available"} · {evidence[0]?.id || "—"}
              </option>
            </Select>
          </FormField>
          <FormField label="Operator">
            <Select
              value={proofForm.operator}
              onChange={(event) => setProofForm({ ...proofForm, operator: event.target.value })}
            >
              <option value="contains">Contains text</option>
              <option value="equals">Equals full content</option>
            </Select>
          </FormField>
          <FormField label="Expected value">
            <TextInput
              value={proofForm.expected_value}
              onChange={(event) =>
                setProofForm({ ...proofForm, expected_value: event.target.value })
              }
              required
            />
          </FormField>
          {modalError ? <div className="form-error" role="alert">{modalError}</div> : null}
          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setProofOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon={FileCheck2} loading={modalBusy}>
              Save check
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        title="Human approval decision"
        description="This action is recorded against the approval history and audit trail. Approval requires every technical gate to pass."
        wide
      >
        <form className="form-grid" onSubmit={submitApproval}>
          {blockers.length ? (
            <Notice tone="warning" title="Technical gates are not satisfied">
              <ul className="tight-list">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              Rejection is still available and will be recorded.
            </Notice>
          ) : (
            <Notice tone="success" title="All visible gates are satisfied">
              The backend will re-check evidence integrity and review freshness before accepting approval.
            </Notice>
          )}

          <FormField label="Approver ID">
            <TextInput
              value={approvalForm.approver_id}
              onChange={(event) =>
                setApprovalForm({ ...approvalForm, approver_id: event.target.value })
              }
              required
            />
          </FormField>

          <FormField label="Decision">
            <Select
              value={approvalForm.decision}
              onChange={(event) =>
                setApprovalForm({
                  ...approvalForm,
                  decision: event.target.value as "APPROVE" | "REJECT",
                })
              }
            >
              <option value="APPROVE">Approve</option>
              <option value="REJECT">Reject</option>
            </Select>
          </FormField>

          <FormField label="Reason" hint="Recorded verbatim in the audit trail.">
            <TextArea
              value={approvalForm.reason}
              onChange={(event) => setApprovalForm({ ...approvalForm, reason: event.target.value })}
              rows={3}
              minLength={5}
              required
            />
          </FormField>

          <FormField label="Approval token" hint="Local demo authorization token from backend/.env.">
            <TextInput
              type="password"
              value={approvalForm.token}
              onChange={(event) => setApprovalForm({ ...approvalForm, token: event.target.value })}
              required
            />
          </FormField>

          {modalError ? <div className="form-error" role="alert">{modalError}</div> : null}

          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setApprovalOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={approvalForm.decision === "APPROVE" ? "success" : "danger"}
              icon={approvalForm.decision === "APPROVE" ? CheckCircle2 : XCircle}
              loading={modalBusy}
            >
              Record {approvalForm.decision === "APPROVE" ? "approval" : "rejection"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function GateRow({
  index,
  title,
  description,
  status,
  action,
}: {
  index: string;
  title: string;
  description: string;
  status: string;
  action?: ReactNode;
}) {
  return (
    <div className="gate-row">
      <span className="gate-index">{index}</span>
      <div className="gate-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <StatusBadge status={status} label={statusLabel(status)} />
      {action ? <div className="gate-action">{action}</div> : null}
    </div>
  );
}

function FindingRow({ finding }: { finding: AdversarialFinding }) {
  return (
    <div className={cx("finding-row", `finding-${findingTone(finding.severity)}`)}>
      <StatusBadge status={finding.severity} label={finding.severity} tone={findingTone(finding.severity)} />
      <div>
        <strong>{finding.code.replaceAll("_", " ")}</strong>
        <p>{finding.message}</p>
      </div>
    </div>
  );
}

function SignalRow({
  icon: Icon,
  label,
  value,
  tone,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: string;
  detail: string;
}) {
  return (
    <div className="signal-row">
      <div className={cx("signal-icon", `tone-${tone}`)}>
        <Icon size={15} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <span className="signal-detail">{detail}</span>
    </div>
  );
}
