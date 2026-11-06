import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bot,
  CircleAlert,
  FileCheck2,
  FolderLock,
  History,
  Network,
  PlayCircle,
  ShieldCheck,
  Swords,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { useData } from "../context/DataContext";
import {
  commitmentHealth,
  latestAdversarial,
  latestVerification,
} from "../lib/derive";
import {
  cx,
  formatDay,
  relativeTime,
  shortId,
  statusLabel,
  statusTone,
} from "../lib/format";
import { TrustGraph } from "../components/TrustGraph";
import {
  Card,
  ErrorState,
  MetricCard,
  ProgressRing,
  SectionHeading,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";
import type { AuditEvent, TrustGraphData } from "../types";

const EVENT_ICONS: Record<string, LucideIcon> = {
  COMMITMENT_CREATED: FileCheck2,
  EVIDENCE_ATTACHED: FolderLock,
  EVIDENCE_INTEGRITY_CHECK: ShieldCheck,
  PROOF_CHECKS_CREATED: FileCheck2,
  PROOF_EVALUATED: Bot,
  INDEPENDENT_REVIEW_COMPLETED: ShieldCheck,
  ADVERSARIAL_REVIEW_COMPLETED: Swords,
  HUMAN_APPROVAL_DECISION: UserCheck,
  TRUST_COLLAPSE_DETECTED: CircleAlert,
  DEPENDENCY_CREATED: Network,
  DEMO_EVIDENCE_TAMPERED: CircleAlert,
};

function eventLabel(eventType: string) {
  return statusLabel(eventType);
}

function actorFor(event: AuditEvent) {
  const details = event.details;

  if (details && typeof details === "object" && "actor" in details) {
    const actor = (details as { actor?: { name?: string; role?: string } }).actor;
    return actor?.name || actor?.role || "system";
  }

  return "system";
}

export function Overview() {
  const {
    commitments,
    details,
    passports,
    reviews,
    audits,
    loading,
    error,
    refresh,
    lastUpdated,
  } = useData();
  const [graph, setGraph] = useState<TrustGraphData | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    void api
      .trustGraph()
      .then((result) => {
        if (active) setGraph(result);
      })
      .catch(() => {
        if (active) setGraph(null);
      });

    return () => {
      active = false;
    };
  }, [lastUpdated]);

  const metrics = useMemo(() => {
    const approved = commitments.filter((item) => item.status === "APPROVED").length;
    const invalidated = commitments.filter((item) => item.status === "INVALIDATED").length;
    const pending = commitments.filter(
      (item) =>
        item.status === "EVIDENCE_PENDING" ||
        item.status === "UNDER_REVIEW",
    ).length;
    const evidenceFailures = Object.values(passports).reduce(
      (total, passport) =>
        total + passport.evidence.filter((item) => item.integrity !== "PASS").length,
      0,
    );
    const criticalFindings = Object.values(reviews).reduce(
      (total, reviewSet) =>
        total +
        (reviewSet.adversarial_reviews?.flatMap((item) =>
          item.findings.filter((finding) => finding.severity === "CRITICAL"),
        ).length ?? 0),
      0,
    );
    const trustScore =
      commitments.length === 0
        ? 0
        : commitments.reduce(
            (total, commitment) =>
              total + commitmentHealth(commitment, passports[commitment.id]),
            0,
          ) / commitments.length;

    return {
      approved,
      invalidated,
      pending,
      evidenceFailures,
      criticalFindings,
      trustScore,
    };
  }, [commitments, passports, reviews]);

  const pendingApprovals = useMemo(
    () =>
      commitments
        .filter(
          (item) =>
            item.status === "UNDER_REVIEW" ||
            item.status === "EVIDENCE_PENDING",
        )
        .slice(0, 5),
    [commitments],
  );

  const recentAudit = useMemo(() => {
    const events = Object.entries(audits).flatMap(([commitmentId, items]) =>
      items.map((event) => ({ ...event, commitmentId })),
    );

    return events
      .sort(
        (first, second) =>
          new Date(second.created_at).getTime() -
          new Date(first.created_at).getTime(),
      )
      .slice(0, 10);
  }, [audits]);

  const agentActivity = useMemo(() => {
    const rows: Array<{
      id: string;
      agent: string;
      result: string;
      commitment: string;
      commitmentId: string;
      created_at: string;
      tone: string;
    }> = [];

    for (const commitment of commitments) {
      const verification = latestVerification(reviews[commitment.id]);
      const adversarial = latestAdversarial(reviews[commitment.id]);

      if (verification) {
        rows.push({
          id: verification.review_id,
          agent: "VERIFIER",
          result: verification.result,
          commitment: commitment.title,
          commitmentId: commitment.id,
          created_at: verification.created_at,
          tone: statusTone(verification.result),
        });
      }

      if (adversarial) {
        rows.push({
          id: adversarial.review_id,
          agent: "ADVERSARY",
          result: adversarial.result,
          commitment: commitment.title,
          commitmentId: commitment.id,
          created_at: adversarial.created_at,
          tone: statusTone(adversarial.result),
        });
      }
    }

    return rows
      .sort(
        (first, second) =>
          new Date(second.created_at).getTime() -
          new Date(first.created_at).getTime(),
      )
      .slice(0, 6);
  }, [commitments, reviews]);

  const evidenceRecords = useMemo(
    () =>
      commitments.flatMap((commitment) =>
        (details[commitment.id]?.evidence ?? []).map((evidence) => ({
          ...evidence,
          integrity:
            passports[commitment.id]?.evidence.find(
              (item) => item.evidence_id === evidence.id,
            )?.integrity ?? "UNKNOWN",
        })),
      ),
    [commitments, details, passports],
  );

  const evidenceIntact = evidenceRecords.filter(
    (item) => item.integrity === "PASS",
  ).length;

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-copy">
          <div className="hero-kicker">
            <span className="hero-pulse" />
            Executive command center · live assurance
          </div>
          <h1>
            Trust is a live signal.
            <br />
            <span>Not a document.</span>
          </h1>
          <p>
            PACTORA turns business commitments into verifiable, auditable proof.
            Every claim is backed by evidence, deterministic checks, independent
            review, adversarial challenge and accountable human approval.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary button-md" to="/demo">
              <PlayCircle size={16} />
              <span>Run guided demonstration</span>
            </Link>
            <Link className="button button-secondary button-md" to="/graph">
              <Network size={16} />
              <span>Open trust graph</span>
            </Link>
          </div>
          <div className="hero-foot">
            <span>
              <strong>{commitments.length}</strong> commitments under assurance
            </span>
            <span className="hero-separator" />
            <span>
              <strong>{evidenceRecords.length}</strong> evidence records fingerprinted
            </span>
            <span className="hero-separator" />
            <span>{lastUpdated ? `Synced ${relativeTime(lastUpdated)}` : "Waiting for sync"}</span>
          </div>
        </div>

        <div className="hero-health">
          <ProgressRing
            value={metrics.trustScore}
            size={178}
            stroke={12}
            tone={
              metrics.invalidated > 0
                ? "danger"
                : metrics.trustScore > 0.7
                  ? "success"
                  : "warning"
            }
            label={`${Math.round(metrics.trustScore * 100)}`}
            sublabel="portfolio trust index"
          />
          <div className="trust-composition">
            <div>
              <span>Approved</span>
              <strong>{metrics.approved}</strong>
            </div>
            <div>
              <span>Evidence failures</span>
              <strong className={metrics.evidenceFailures ? "text-danger" : ""}>
                {metrics.evidenceFailures}
              </strong>
            </div>
            <div>
              <span>Critical findings</span>
              <strong className={metrics.criticalFindings ? "text-danger" : ""}>
                {metrics.criticalFindings}
              </strong>
            </div>
          </div>
          <div className="hero-health-note">
            Derived from live passport, evidence and review state. Not a
            self-reported score.
          </div>
        </div>
      </section>

      <div className="metrics-grid">
        <MetricCard
          label="Commitments"
          value={commitments.length}
          detail={`${metrics.pending} awaiting a decision`}
          icon={FileCheck2}
          tone="info"
        />
        <MetricCard
          label="Approved"
          value={metrics.approved}
          detail="Human-approved with passing gates"
          icon={BadgeCheck}
          tone="success"
        />
        <MetricCard
          label="Invalidated"
          value={metrics.invalidated}
          detail="Locked by integrity collapse"
          icon={CircleAlert}
          tone={metrics.invalidated ? "danger" : "neutral"}
        />
        <MetricCard
          label="Evidence integrity"
          value={`${evidenceIntact}/${evidenceRecords.length}`}
          detail="Fingerprint matches"
          icon={FolderLock}
          tone={metrics.evidenceFailures ? "danger" : "success"}
        />
        <MetricCard
          label="Critical findings"
          value={metrics.criticalFindings}
          detail="Unresolved adversarial findings"
          icon={Swords}
          tone={metrics.criticalFindings ? "warning" : "success"}
        />
      </div>

      <div className="overview-grid">
        <Card className="portfolio-card">
          <SectionHeading
            title="Commitment portfolio"
            subtitle="Trust state across every active commitment."
            action={
              <Link to="/commitments" className="text-link">
                View all <ArrowRight size={14} />
              </Link>
            }
          />
          <div className="table-wrap">
            <table className="data-table commitment-table">
              <thead>
                <tr>
                  <th>Commitment</th>
                  <th>Status</th>
                  <th>Evidence</th>
                  <th>Latest review</th>
                  <th>Trust</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {commitments.slice(0, 7).map((commitment) => {
                  const passport = passports[commitment.id];
                  const evidence = details[commitment.id]?.evidence ?? [];
                  const verification = latestVerification(reviews[commitment.id]);
                  const health = commitmentHealth(commitment, passport);
                  const integrity = passport?.trust_summary.evidence_integrity;

                  return (
                    <tr
                      key={commitment.id}
                      onClick={() => navigate(`/commitments/${commitment.id}`)}
                      className="clickable-row"
                    >
                      <td>
                        <div className="table-primary">
                          <strong>{commitment.title}</strong>
                          <span className="mono subtle">{shortId(commitment.id, 16)}</span>
                        </div>
                      </td>
                      <td>
                        <StatusBadge
                          status={commitment.status}
                          label={statusLabel(commitment.status)}
                        />
                      </td>
                      <td>
                        <div className="table-primary">
                          <span>{evidence.length} records</span>
                          <span
                            className={cx(
                              "inline-tone",
                              integrity === "INTACT"
                                ? "text-success"
                                : integrity === "COLLAPSED"
                                  ? "text-danger"
                                  : "subtle",
                            )}
                          >
                            {integrity === "INTACT"
                              ? "Intact"
                              : integrity === "COLLAPSED"
                                ? "Collapsed"
                                : "Unverified"}
                          </span>
                        </div>
                      </td>
                      <td>
                        {verification ? (
                          <div className="table-primary">
                            <span>{statusLabel(verification.result)}</span>
                            <span className="subtle">
                              {relativeTime(verification.created_at)}
                            </span>
                          </div>
                        ) : (
                          <span className="subtle">Not run</span>
                        )}
                      </td>
                      <td>
                        <div className="trust-meter" aria-label={`Trust ${Math.round(health * 100)} percent`}>
                          <span style={{ width: `${Math.round(health * 100)}%` }} />
                        </div>
                      </td>
                      <td>
                        <ArrowRight size={15} className="row-arrow" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="overview-side">
          <Card className="queue-card">
            <SectionHeading
              title="Approval queue"
              subtitle="Decisions waiting on human authorization."
              action={
                <Link to="/approvals" className="text-link">
                  Open <ArrowRight size={14} />
                </Link>
              }
            />
            {pendingApprovals.length === 0 ? (
              <div className="compact-empty">
                <UserCheck size={18} />
                <p>No approvals are waiting.</p>
              </div>
            ) : (
              <div className="queue-list">
                {pendingApprovals.map((commitment) => {
                  const passport = passports[commitment.id];
                  const proof = passport?.trust_summary.proof_state;

                  return (
                    <Link
                      key={commitment.id}
                      className="queue-item"
                      to={`/commitments/${commitment.id}`}
                    >
                      <div>
                        <strong>{commitment.title}</strong>
                        <span>
                          {commitment.owner} · proof {proof ? statusLabel(proof) : "not run"}
                        </span>
                      </div>
                      <StatusBadge
                        status={commitment.status}
                        label={statusLabel(commitment.status)}
                      />
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="agent-card">
            <SectionHeading
              title="Agent activity"
              subtitle="Actual backend review records."
              action={
                <Link to="/agents" className="text-link">
                  Agents <ArrowRight size={14} />
                </Link>
              }
            />
            {agentActivity.length === 0 ? (
              <div className="compact-empty">
                <Bot size={18} />
                <p>No agent reviews recorded yet.</p>
              </div>
            ) : (
              <div className="activity-list">
                {agentActivity.map((item) => (
                  <Link
                    key={item.id}
                    to={`/commitments/${item.commitmentId}`}
                    className="activity-item"
                  >
                    <div className="activity-icon">
                      {item.agent === "VERIFIER" ? (
                        <ShieldCheck size={15} />
                      ) : (
                        <Swords size={15} />
                      )}
                    </div>
                    <div className="activity-copy">
                      <div>
                        <strong>{item.agent}</strong>
                        <span className={cx("activity-result", `text-${item.tone}`)}>
                          {statusLabel(item.result)}
                        </span>
                      </div>
                      <p>{item.commitment}</p>
                      <span>{relativeTime(item.created_at)} · {item.id}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card className="graph-card">
        <SectionHeading
          title="PACTORA Trust Graph"
          subtitle="One compromised evidence record can collapse a commitment and every dependent commitment."
          action={
            <Link to="/graph" className="text-link">
              Explore graph <ArrowRight size={14} />
            </Link>
          }
        />
        <TrustGraph
          graph={graph}
          compact
          height={310}
          onSelectNode={(node) => {
            if (node.type === "COMMITMENT") {
              navigate(`/commitments/${node.id}`);
              return;
            }

            if (node.type === "EVIDENCE") {
              const owner = Object.values(details).find((detail) =>
                detail.evidence.some((item) => item.id === node.id),
              );

              if (owner) navigate(`/commitments/${owner.commitment.id}`);
            }
          }}
        />
      </Card>

      <div className="overview-bottom">
        <Card>
          <SectionHeading
            title="Recent audit events"
            subtitle="Append-only activity across the network."
            action={
              <Link to="/audit" className="text-link">
                Full timeline <ArrowRight size={14} />
              </Link>
            }
          />
          <div className="timeline timeline-compact">
            {recentAudit.map((event) => {
              const Icon = EVENT_ICONS[event.event_type] || Activity;
              const commitment =
                commitments.find((item) => item.id === event.commitmentId)?.title ||
                shortId(event.commitmentId, 15);

              return (
                <div className="timeline-item" key={event.id}>
                  <div className="timeline-marker">
                    <Icon size={14} />
                  </div>
                  <div className="timeline-content">
                    <div className="timeline-title">
                      <strong>{eventLabel(event.event_type)}</strong>
                      <span>{formatDay(event.created_at)}</span>
                    </div>
                    <p>{commitment} · {actorFor(event)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <SectionHeading
            title="Evidence posture"
            subtitle="Integrity state of stored evidence."
            action={
              <Link to="/evidence" className="text-link">
                Vault <ArrowRight size={14} />
              </Link>
            }
          />
          <div className="evidence-posture">
            <ProgressRing
              value={
                evidenceRecords.length
                  ? evidenceIntact / evidenceRecords.length
                  : 0
              }
              size={124}
              stroke={9}
              tone={evidenceIntact === evidenceRecords.length ? "success" : "danger"}
              label={`${evidenceIntact}/${evidenceRecords.length}`}
              sublabel="intact"
            />
            <div className="posture-list">
              <div>
                <span className="posture-dot posture-ok" />
                <span>Verified fingerprints</span>
                <strong>{evidenceIntact}</strong>
              </div>
              <div>
                <span className="posture-dot posture-bad" />
                <span>Failed / missing</span>
                <strong>{evidenceRecords.length - evidenceIntact}</strong>
              </div>
              <div>
                <span className="posture-dot posture-neutral" />
                <span>Commitments covered</span>
                <strong>{new Set(evidenceRecords.map((item) => item.commitment_id)).size}</strong>
              </div>
            </div>
          </div>
          <div className="posture-note">
            SHA-256 fingerprints detect file changes. They do not establish
            evidence authenticity or semantic truth.
          </div>
        </Card>
      </div>

      <div className="footer-strip">
        <span>PACTORA ∞ · Proof over promises</span>
        <span className="footer-separator" />
        <span>Every number on this page is derived from live backend records.</span>
        <span className="footer-spacer" />
        <History size={13} /> {recentAudit.length} recent events
      </div>
    </div>
  );
}
