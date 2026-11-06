import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BrainCircuit,
  CircleAlert,
  Radar,
  RefreshCw,
  ShieldCheck,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useData } from "../context/DataContext";
import {
  cx,
  formatDate,
  relativeTime,
  severityTone,
  shortId,
  statusLabel,
  statusTone,
} from "../lib/format";
import {
  Button,
  Card,
  ErrorState,
  Notice,
  PageHeader,
  Select,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";
import type { AgentReport, AgentsOverview } from "../types";

const AGENT_ICONS: Record<string, LucideIcon> = {
  ORACLE: BrainCircuit,
  VERIFIER: ShieldCheck,
  ADVERSARY: Swords,
  SENTINEL: Radar,
};

const AGENT_NOTES: Record<string, string> = {
  ORACLE:
    "Deterministic portfolio risk synthesis computed from live commitments, evidence and review records. No generative claim is invented.",
  VERIFIER:
    "Re-runs configured checks against intact evidence and records a separate review. It does not establish semantic truth.",
  ADVERSARY:
    "Applies explicit heuristic rules to surface evidence weaknesses and limitations. Findings are real backend records.",
  SENTINEL:
    "Recomputes evidence fingerprints and propagates trust collapse to dependent commitments.",
};

export function Agents() {
  const { commitments, reviews, audits, passports, loading, error, refresh } = useData();
  const [overview, setOverview] = useState<AgentsOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selectedCommitment, setSelectedCommitment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const result = await api.agentsOverview();
      setOverview(result);
      setOverviewError(null);
    } catch (caught) {
      setOverviewError(
        caught instanceof ApiError ? caught.message : "Agent overview could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedCommitment && commitments.length > 0) {
      setSelectedCommitment(commitments[0].id);
    }
  }, [commitments, selectedCommitment]);

  const activity = useMemo(() => {
    const records: Array<{
      agent: string;
      id: string;
      result: string;
      commitmentId: string;
      commitmentTitle: string;
      created_at: string;
    }> = [];

    for (const commitment of commitments) {
      const reviewSet = reviews[commitment.id];

      for (const review of reviewSet?.independent_reviews ?? []) {
        records.push({
          agent: "VERIFIER",
          id: review.review_id,
          result: review.result,
          commitmentId: commitment.id,
          commitmentTitle: commitment.title,
          created_at: review.created_at,
        });
      }

      for (const review of reviewSet?.adversarial_reviews ?? []) {
        records.push({
          agent: "ADVERSARY",
          id: review.review_id,
          result: review.result,
          commitmentId: commitment.id,
          commitmentTitle: commitment.title,
          created_at: review.created_at,
        });
      }
    }

    return records
      .sort(
        (first, second) =>
          new Date(second.created_at).getTime() - new Date(first.created_at).getTime(),
      )
      .slice(0, 8);
  }, [commitments, reviews]);

  const sentinelEvents = useMemo(
    () =>
      Object.entries(audits)
        .flatMap(([commitmentId, events]) =>
          events
            .filter((event) => event.event_type === "TRUST_COLLAPSE_DETECTED")
            .map((event) => ({ ...event, commitmentId })),
        )
        .sort(
          (first, second) =>
            new Date(second.created_at).getTime() - new Date(first.created_at).getTime(),
        )
        .slice(0, 5),
    [audits],
  );

  const execute = async (
    key: string,
    action: () => Promise<{ text: string; tone: "success" | "danger" | "warning" }>,
  ) => {
    setBusy(key);
    setFeedback(null);

    try {
      const result = await action();
      setFeedback(result);
      await Promise.all([refresh(), loadOverview()]);
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "Agent action failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const selected = commitments.find((item) => item.id === selectedCommitment);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="AI Agent Command Center"
        title="Four agents. One verifiable record."
        description="Agent status and reports below are derived from actual backend review records. Nothing is fabricated, and no manual dispatch is described as autonomous."
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={() => void loadOverview()}
            loading={busy === "oracle"}
          >
            Re-synthesize ORACLE
          </Button>
        }
      />

      {overviewError ? <Notice tone="danger" title="Agent overview unavailable">{overviewError}</Notice> : null}

      <div className="agent-grid">
        {(overview?.agents ?? []).map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
        {!overview && !overviewError ? (
          <Card>
            <div className="compact-empty">
              <Radar size={18} />
              <p>Loading live agent reports…</p>
            </div>
          </Card>
        ) : null}
      </div>

      <Card>
        <div className="agent-dispatch">
          <div>
            <h2>Dispatch a real review</h2>
            <p>
              Select a commitment, then run the corresponding backend review.
              Results are persisted and appear in the audit trail.
            </p>
          </div>
          <div className="dispatch-controls">
            <Select
              value={selectedCommitment}
              onChange={(event) => setSelectedCommitment(event.target.value)}
              aria-label="Select commitment"
            >
              {commitments.map((commitment) => (
                <option key={commitment.id} value={commitment.id}>
                  {commitment.title} · {commitment.id}
                </option>
              ))}
            </Select>
            <div className="dispatch-buttons">
              <Button
                icon={ShieldCheck}
                loading={busy === "verifier"}
                disabled={!selected}
                onClick={() =>
                  execute("verifier", async () => {
                    if (!selected) throw new Error("No commitment selected.");
                    const result = await api.independentReview(selected.id);
                    return {
                      tone: result.result === "PASS" ? "success" : "danger",
                      text: `VERIFIER recorded ${result.review_id} with result ${result.result}.`,
                    };
                  })
                }
              >
                Run VERIFIER
              </Button>
              <Button
                icon={Swords}
                loading={busy === "adversary"}
                disabled={!selected}
                onClick={() =>
                  execute("adversary", async () => {
                    if (!selected) throw new Error("No commitment selected.");
                    const result = await api.adversarialReview(selected.id);
                    return {
                      tone: result.result === "CHALLENGED" ? "danger" : "warning",
                      text: `ADVERSARY recorded ${result.review_id} with ${result.findings.length} findings.`,
                    };
                  })
                }
              >
                Run ADVERSARY
              </Button>
              <Button
                icon={Radar}
                loading={busy === "sentinel"}
                disabled={!selected}
                onClick={() =>
                  execute("sentinel", async () => {
                    if (!selected) throw new Error("No commitment selected.");
                    const result = await api.trustScan(selected.id);
                    return {
                      tone: result.trust_status === "INTACT" ? "success" : "danger",
                      text: `SENTINEL scan completed: trust ${result.trust_status}. ${result.message}`,
                    };
                  })
                }
              >
                Run SENTINEL
              </Button>
            </div>
          </div>
        </div>

        {feedback ? (
          <Notice tone={feedback.tone}>{feedback.text}</Notice>
        ) : null}

        <div className="dispatch-note">
          ORACLE is re-synthesized from current records. VERIFIER, ADVERSARY and
          SENTINEL only run when you explicitly dispatch them.
        </div>
      </Card>

      <div className="overview-bottom">
        <Card>
          <div className="section-heading">
            <div>
              <h2>Agent activity history</h2>
              <p>Actual review records across the portfolio.</p>
            </div>
          </div>
          {activity.length === 0 ? (
            <div className="compact-empty">
              <Radar size={18} />
              <p>No agent review records yet. Dispatch a review above.</p>
            </div>
          ) : (
            <div className="activity-list">
              {activity.map((item) => (
                <Link
                  key={item.id}
                  to={`/commitments/${item.commitmentId}`}
                  className="activity-item"
                >
                  <div className="activity-icon">
                    {item.agent === "VERIFIER" ? <ShieldCheck size={15} /> : <Swords size={15} />}
                  </div>
                  <div className="activity-copy">
                    <div>
                      <strong>{item.agent}</strong>
                      <span className={cx("activity-result", `text-${statusTone(item.result)}`)}>
                        {statusLabel(item.result)}
                      </span>
                    </div>
                    <p>{item.commitmentTitle}</p>
                    <span>{relativeTime(item.created_at)} · {item.id}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="section-heading">
            <div>
              <h2>SENTINEL collapse events</h2>
              <p>Recorded trust-collapse events with affected roots.</p>
            </div>
          </div>
          {sentinelEvents.length === 0 ? (
            <div className="compact-empty">
              <CircleAlert size={18} />
              <p>No trust-collapse events recorded.</p>
            </div>
          ) : (
            <div className="event-stack">
              {sentinelEvents.map((event) => (
                <Link key={event.id} to={`/commitments/${event.commitmentId}`} className="event-row">
                  <CircleAlert size={15} className="text-danger" />
                  <div>
                    <strong>{commitments.find((item) => item.id === event.commitmentId)?.title || shortId(event.commitmentId, 18)}</strong>
                    <span>{formatDate(event.created_at)}</span>
                  </div>
                  <StatusBadge status="COLLAPSED" label="Collapsed" tone="danger" />
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="footer-strip">
        <BrainCircuit size={13} />
        <span>
          {overview ? `Agent synthesis generated ${relativeTime(overview.generated_at)}.` : "Awaiting synthesis."}
        </span>
        <span className="footer-separator" />
        <span>{Object.keys(passports).length} passport snapshots observed.</span>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentReport }) {
  const Icon = AGENT_ICONS[agent.id] || Radar;
  const findingCount = agent.last_report.findings.length;
  const reportId =
    agent.last_report.report_id ||
    agent.last_report.review_id ||
    agent.last_report.last_collapse_event_id ||
    null;

  return (
    <Card className="agent-profile">
      <div className="agent-profile-head">
        <div className={cx("agent-emblem", `agent-${agent.id.toLowerCase()}`)}>
          <Icon size={20} />
        </div>
        <div className="agent-identity">
          <div>
            <h2>{agent.name}</h2>
            <StatusBadge status={agent.status} label={statusLabel(agent.status)} />
          </div>
          <p>{agent.role}</p>
        </div>
      </div>

      <p className="agent-note">{AGENT_NOTES[agent.id]}</p>

      <div className="agent-report">
        <div className="agent-report-top">
          <span>Last report</span>
          <span>{formatDate(agent.last_report.generated_at)}</span>
        </div>
        <p>{agent.last_report.summary}</p>
        <div className="agent-report-meta">
          {reportId ? <span className="mono">{reportId}</span> : <span>Live synthesis</span>}
          {agent.last_report.commitment_id ? (
            <Link to={`/commitments/${agent.last_report.commitment_id}`} className="inline-link">
              {agent.last_report.commitment_title || shortId(agent.last_report.commitment_id, 16)}
            </Link>
          ) : null}
          <span>{findingCount} findings</span>
        </div>
      </div>

      <div className="agent-findings">
        {agent.last_report.findings.length === 0 ? (
          <p className="agent-clear">No findings recorded.</p>
        ) : (
          agent.last_report.findings.slice(0, 4).map((finding) => (
            <div key={`${agent.id}-${finding.code}-${finding.message}`} className="agent-finding">
              <StatusBadge
                status={finding.severity}
                label={finding.severity}
                tone={severityTone(finding.severity)}
              />
              <div>
                <strong>{finding.code.replaceAll("_", " ")}</strong>
                <p>{finding.message}</p>
              </div>
            </div>
          ))
        )}
        {agent.last_report.findings.length > 4 ? (
          <span className="subtle">+{agent.last_report.findings.length - 4} more findings</span>
        ) : null}
      </div>

      <div className="agent-recommendations">
        <span>Recommendations</span>
        <ul>
          {agent.last_report.recommendations.slice(0, 3).map((recommendation) => (
            <li key={recommendation}>{recommendation}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
