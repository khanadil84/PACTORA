import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  BadgeCheck,
  CircleAlert,
  Download,
  FileCheck2,
  FolderLock,
  Printer,
  ShieldCheck,
  Swords,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { useData } from "../context/DataContext";
import { criticalFindings } from "../lib/derive";
import {
  cx,
  downloadJson,
  formatDate,
  shortHash,
  statusLabel,
  statusTone,
} from "../lib/format";
import {
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";

export function Passport() {
  const { commitments, passports, loading, error, refresh } = useData();
  const { id } = useParams();
  const navigate = useNavigate();
  const selectedId = id || commitments[0]?.id || "";
  const commitment = commitments.find((item) => item.id === selectedId);
  const passport = selectedId ? passports[selectedId] : undefined;

  useEffect(() => {
    if (!id && commitments.length > 0) {
      navigate(`/passport/${commitments[0].id}`, { replace: true });
    }
  }, [commitments, id, navigate]);

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  if (!commitments.length) {
    return (
      <EmptyState
        icon={BadgeCheck}
        title="No passport can be generated"
        description="Create a commitment and attach evidence to produce an assurance snapshot."
      />
    );
  }

  if (!commitment || !passport) {
    return (
      <EmptyState
        icon={BadgeCheck}
        title="Passport not found"
        description="This commitment may not exist or may be outside your current read scope."
      />
    );
  }

  const summary = passport.trust_summary;
  const latestProof = passport.proof.history[0];
  const latestVerification = passport.verification.history[0];
  const latestAdversarial = passport.adversarial.history[0];
  const latestApproval = passport.approval.history[0];
  const critical = criticalFindings(latestAdversarial?.findings);
  const collapsed =
    summary.evidence_integrity === "COLLAPSED" || commitment.status === "INVALIDATED";

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Trust Passport"
        title="Assurance you can inspect."
        description="A transparent, unsigned snapshot of what is known, what was verified and what remains unproven."
        actions={
          <div className="page-actions">
            <Select
              value={selectedId}
              onChange={(event) => navigate(`/passport/${event.target.value}`)}
              aria-label="Select commitment"
            >
              {commitments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.id}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              icon={Download}
              onClick={() =>
                downloadJson(`${passport.passport_id}.json`, passport)
              }
            >
              Download JSON
            </Button>
            <Button variant="secondary" icon={Printer} onClick={() => window.print()}>
              Print
            </Button>
          </div>
        }
      />

      <article className={cx("passport-document", collapsed && "passport-collapsed")}>
        <header className="passport-header">
          <div className="passport-brand">
            <div className="passport-mark">
              <BadgeCheck size={26} />
            </div>
            <div>
              <p>PACTORA ∞</p>
              <h2>Commitment Assurance Snapshot</h2>
              <span>{passport.passport_type.replaceAll("_", " ")}</span>
            </div>
          </div>
          <div className={cx("passport-seal", collapsed ? "seal-collapsed" : "seal-intact")}>
            <span>{collapsed ? "Trust collapsed" : summary.commitment_status === "APPROVED" ? "Human approved" : "Unapproved"}</span>
            <strong>{collapsed ? "INVALID" : summary.commitment_status.replaceAll("_", " ")}</strong>
            <small>Unsigned snapshot</small>
          </div>
        </header>

        <div className="passport-identity">
          <div>
            <span>Passport ID</span>
            <div className="identity-value">
              <code>{passport.passport_id}</code>
              <CopyButton value={passport.passport_id} />
            </div>
          </div>
          <div>
            <span>Generated</span>
            <strong>{formatDate(passport.generated_at)}</strong>
          </div>
          <div>
            <span>Commitment</span>
            <Link to={`/commitments/${commitment.id}`} className="inline-link">
              {commitment.id}
            </Link>
          </div>
          <div>
            <span>Owner</span>
            <strong>{commitment.owner}</strong>
          </div>
        </div>

        <section className="passport-section">
          <div className="passport-section-head">
            <h3>Business claim</h3>
            <StatusBadge status={commitment.status} label={statusLabel(commitment.status)} />
          </div>
          <blockquote>{commitment.claim}</blockquote>
          <div className="passport-criteria">
            <span>Acceptance criteria</span>
            <p>{commitment.acceptance_criteria}</p>
          </div>
        </section>

        <section className="passport-section">
          <div className="passport-section-head">
            <h3>Trust summary</h3>
            <span className="section-caption">Derived from current records</span>
          </div>
          <div className="passport-summary-grid">
            <SummaryTile icon={FolderLock} label="Evidence integrity" value={summary.evidence_integrity} />
            <SummaryTile icon={FileCheck2} label="Deterministic proof" value={summary.proof_state} />
            <SummaryTile icon={ShieldCheck} label="Independent review" value={summary.independent_review_state} />
            <SummaryTile icon={Swords} label="Adversarial review" value={summary.adversarial_review_state} />
            <SummaryTile icon={UserCheck} label="Human approval" value={summary.human_approval_state} />
            <div className={cx("summary-tile", "summary-semantic")}>
              <span>Claim semantically verified</span>
              <strong className="text-warning">FALSE</strong>
              <small>PACTORA never asserts semantic truth from file checks.</small>
            </div>
          </div>
        </section>

        <section className="passport-section">
          <div className="passport-section-head">
            <h3>Evidence records</h3>
            <span className="section-caption">{passport.evidence.length} records</span>
          </div>
          {passport.evidence.length === 0 ? (
            <p className="passport-empty">No evidence is attached.</p>
          ) : (
            <div className="passport-table">
              <div className="passport-table-head">
                <span>Evidence</span>
                <span>Recorded SHA-256</span>
                <span>Current SHA-256</span>
                <span>Integrity</span>
              </div>
              {passport.evidence.map((item) => (
                <div className="passport-table-row" key={item.evidence_id}>
                  <div>
                    <strong>{item.filename}</strong>
                    <span className="mono">{item.evidence_id}</span>
                  </div>
                  <code title={item.sha256}>{shortHash(item.sha256, 16)}</code>
                  <code title={item.current_sha256 || ""}>
                    {item.current_sha256 ? shortHash(item.current_sha256, 16) : "missing"}
                  </code>
                  <StatusBadge
                    status={item.integrity}
                    label={item.integrity === "PASS" ? "Verified" : "Failed"}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="passport-two-col">
          <section className="passport-section">
            <div className="passport-section-head">
              <h3>Deterministic proof</h3>
              <StatusBadge status={summary.proof_state} label={statusLabel(summary.proof_state)} />
            </div>
            {latestProof ? (
              <>
                <div className="passport-meta">
                  <span className="mono">{latestProof.evaluation_id}</span>
                  <span>{formatDate(latestProof.created_at)}</span>
                </div>
                <div className="passport-check-list">
                  {latestProof.details.map((detail) => (
                    <div key={detail.check_id}>
                      <StatusBadge status={detail.outcome} label={detail.outcome} dot={false} />
                      <span>{detail.name || detail.check_id}</span>
                      <span className="subtle">{detail.reason}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="passport-empty">No proof evaluation has been recorded.</p>
            )}
          </section>

          <section className="passport-section">
            <div className="passport-section-head">
              <h3>Independent verification</h3>
              <StatusBadge
                status={summary.independent_review_state}
                label={statusLabel(summary.independent_review_state)}
              />
            </div>
            {latestVerification ? (
              <>
                <div className="passport-meta">
                  <span className="mono">{latestVerification.review_id}</span>
                  <span>{formatDate(latestVerification.created_at)}</span>
                </div>
                <p className="passport-method">
                  Method: {latestVerification.details.method || "deterministic_recheck"}
                </p>
                <div className="passport-check-list">
                  {(latestVerification.details.results ?? []).map((result) => (
                    <div key={result.check_id}>
                      <StatusBadge status={result.outcome} label={result.outcome} dot={false} />
                      <span>{result.check_id}</span>
                      <span className="subtle">{result.reason}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="passport-empty">No independent verification has been recorded.</p>
            )}
          </section>
        </div>

        <div className="passport-two-col">
          <section className="passport-section">
            <div className="passport-section-head">
              <h3>Adversarial review</h3>
              <StatusBadge
                status={summary.adversarial_review_state}
                label={statusLabel(summary.adversarial_review_state)}
              />
            </div>
            {latestAdversarial ? (
              <>
                <div className="passport-meta">
                  <span className="mono">{latestAdversarial.review_id}</span>
                  <span>{formatDate(latestAdversarial.created_at)}</span>
                </div>
                <div className="passport-findings">
                  {latestAdversarial.findings.map((finding) => (
                    <div key={`${finding.code}-${finding.message}`}>
                      <StatusBadge
                        status={finding.severity}
                        label={finding.severity}
                        tone={finding.severity === "CRITICAL" ? "danger" : finding.severity === "WARNING" ? "warning" : "info"}
                      />
                      <div>
                        <strong>{finding.code.replaceAll("_", " ")}</strong>
                        <p>{finding.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {critical.length ? (
                  <p className="passport-warning">
                    {critical.length} unresolved critical finding
                    {critical.length === 1 ? "" : "s"} block approval.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="passport-empty">No adversarial review has been recorded.</p>
            )}
          </section>

          <section className="passport-section">
            <div className="passport-section-head">
              <h3>Human approval</h3>
              <StatusBadge
                status={summary.human_approval_state}
                label={statusLabel(summary.human_approval_state)}
              />
            </div>
            {latestApproval ? (
              <>
                <div className="passport-meta">
                  <span className="mono">{latestApproval.id}</span>
                  <span>{formatDate(latestApproval.created_at)}</span>
                </div>
                <div className="passport-approval">
                  <div>
                    <span>Decision</span>
                    <strong>{latestApproval.decision}</strong>
                  </div>
                  <div>
                    <span>Approver</span>
                    <strong>{latestApproval.approver_id}</strong>
                  </div>
                  <div>
                    <span>Reason</span>
                    <p>{latestApproval.reason}</p>
                  </div>
                </div>
              </>
            ) : (
              <p className="passport-empty">No human decision has been recorded.</p>
            )}
          </section>
        </div>

        <section className="passport-section passport-limitations">
          <div className="passport-section-head">
            <h3>Scope limitations</h3>
            <CircleAlert size={16} className="text-warning" />
          </div>
          <ul>
            {summary.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>

        <section className="passport-section">
          <div className="passport-section-head">
            <h3>Audit trail</h3>
            <span className="section-caption">{passport.audit_trail.length} events</span>
          </div>
          <div className="passport-audit">
            {passport.audit_trail.map((event) => (
              <div className="passport-audit-row" key={event.id}>
                <span className="mono subtle">{formatDate(event.created_at)}</span>
                <strong>{statusLabel(event.event_type)}</strong>
                <span className="mono subtle">{event.id.slice(0, 18)}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="passport-footer">
          <span>PACTORA ∞ · Proof over promises</span>
          <span>This document is an unsigned snapshot. It is not a cryptographic credential.</span>
          <span className={cx("passport-footer-state", `text-${statusTone(summary.evidence_integrity)}`)}>
            Evidence {statusLabel(summary.evidence_integrity)}
          </span>
        </footer>
      </article>

      <Card className="passport-related">
        <div>
          <h3>Trace this passport through the trust graph</h3>
          <p>
            See which commitments depend on this one and what happens to them if
            its evidence collapses.
          </p>
        </div>
        <Link to="/graph" className="button button-secondary button-md">
          <ShieldCheck size={15} />
          <span>Open Trust Graph</span>
        </Link>
      </Card>
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className={cx("summary-tile", `tone-${statusTone(value)}`)}>
      <Icon size={16} />
      <span>{label}</span>
      <strong>{statusLabel(value)}</strong>
    </div>
  );
}
