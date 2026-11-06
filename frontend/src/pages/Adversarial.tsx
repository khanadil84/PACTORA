import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CircleAlert,
  FileWarning,
  ShieldAlert,
  Swords,
  TriangleAlert,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useData } from "../context/DataContext";
import { criticalFindings, latestAdversarial } from "../lib/derive";
import {
  cx,
  formatDate,
  relativeTime,
  severityTone,
  shortId,
  statusLabel,
} from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  MetricCard,
  Notice,
  PageHeader,
  SectionHeading,
  Select,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";
import type { AdversarialFinding } from "../types";

export function Adversarial() {
  const { commitments, reviews, loading, error, refresh } = useData();
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);

  useEffect(() => {
    if (!selectedId && commitments.length > 0) {
      setSelectedId(commitments[0].id);
    }
  }, [commitments, selectedId]);

  const commitment = commitments.find((item) => item.id === selectedId);
  const reviewSet = selectedId ? reviews[selectedId] : undefined;
  const latest = latestAdversarial(reviewSet);

  const allFindings = useMemo(
    () =>
      Object.entries(reviews).flatMap(([commitmentId, reviewSetValue]) =>
        (reviewSetValue.adversarial_reviews ?? []).flatMap((review) =>
          (review.findings ?? []).map((finding) => ({
            ...finding,
            reviewId: review.review_id,
            commitmentId,
            created_at: review.created_at,
          })),
        ),
      ),
    [reviews],
  );

  const critical = allFindings.filter((finding) => finding.severity === "CRITICAL");
  const warnings = allFindings.filter((finding) => finding.severity === "WARNING");
  const challenged = commitments.filter(
    (item) => latestAdversarial(reviews[item.id])?.result === "CHALLENGED",
  ).length;

  const runReview = async () => {
    if (!commitment) return;

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.adversarialReview(commitment.id);
      await refresh();
      setFeedback({
        tone: result.result === "CHALLENGED" ? "danger" : "warning",
        text: `${result.review_id} recorded ${result.findings.length} findings with result ${statusLabel(result.result)}.`,
      });
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "Adversarial review failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Adversarial Intelligence"
        title="Assume the claim is not proven."
        description="ADVERSARY applies explicit heuristic rules to expose weak evidence, missing corroboration and unproven semantic claims. It is not an autonomous reasoning model, and its findings are real backend records."
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard label="Critical findings" value={critical.length} detail="Block approval when unresolved" icon={CircleAlert} tone={critical.length ? "danger" : "success"} />
        <MetricCard label="Warnings" value={warnings.length} detail="Known limitations and weaknesses" icon={TriangleAlert} tone={warnings.length ? "warning" : "neutral"} />
        <MetricCard label="Challenged commitments" value={challenged} detail="Latest review result CHALLENGED" icon={ShieldAlert} tone={challenged ? "danger" : "success"} />
        <MetricCard label="Findings recorded" value={allFindings.length} detail="Across all adversarial reviews" icon={Swords} tone="info" />
      </div>

      <Card>
        <div className="selector-bar">
          <div>
            <span className="selector-label">Commitment under challenge</span>
            <Select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {commitments.length === 0 ? <option value="">No commitments</option> : null}
              {commitments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.id}
                </option>
              ))}
            </Select>
          </div>
          {commitment ? (
            <div className="selector-actions">
              <Link to={`/commitments/${commitment.id}`} className="button button-ghost button-md">
                <ArrowRight size={15} />
                <span>Open commitment</span>
              </Link>
              <Button variant="primary" icon={Swords} onClick={runReview} loading={busy}>
                Run adversarial review
              </Button>
            </div>
          ) : null}
        </div>
        {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      </Card>

      {!commitment ? (
        <EmptyState
          icon={Swords}
          title="No commitment selected"
          description="Select a commitment to inspect or run an adversarial review."
        />
      ) : (
        <div className="verification-grid">
          <Card>
            <SectionHeading
              title="Latest challenge"
              subtitle={`Heuristic review of ${commitment.title}`}
              action={
                latest ? (
                  <StatusBadge status={latest.result} label={statusLabel(latest.result)} />
                ) : null
              }
            />
            {latest ? (
              <>
                <div className="review-meta-line">
                  <span className="mono">{latest.review_id}</span>
                  <span>{formatDate(latest.created_at)}</span>
                  <span>{relativeTime(latest.created_at)}</span>
                </div>
                <div className="finding-list">
                  {latest.findings.map((finding) => (
                    <FindingCard
                      key={`${latest.review_id}-${finding.code}-${finding.message}`}
                      finding={finding}
                    />
                  ))}
                </div>
                <Notice tone="warning" title="Interpretation boundary">
                  These findings identify evidence weaknesses. They do not prove
                  the claim is false, and the absence of findings would not prove
                  it true.
                </Notice>
              </>
            ) : (
              <div className="compact-empty">
                <Swords size={18} />
                <p>No adversarial review has been recorded for this commitment.</p>
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading
              title="Review history"
              subtitle="Every challenge is preserved with its original findings."
            />
            {reviewSet?.adversarial_reviews.length ? (
              <div className="history-list">
                {reviewSet.adversarial_reviews.map((review) => {
                  const criticalCount = criticalFindings(review.findings).length;

                  return (
                    <div className="history-row adversarial-history-row" key={review.review_id}>
                      <StatusBadge status={review.result} label={statusLabel(review.result)} />
                      <div>
                        <strong className="mono">{review.review_id}</strong>
                        <span>{formatDate(review.created_at)}</span>
                      </div>
                      <span className={cx(criticalCount ? "text-danger" : "subtle")}>
                        {criticalCount
                          ? `${criticalCount} critical`
                          : `${review.findings.length} findings`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="compact-empty">
                <FileWarning size={18} />
                <p>No historical adversarial reviews.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      <Card>
        <SectionHeading
          title="Portfolio findings"
          subtitle="All recorded adversarial findings, grouped by severity."
        />
        {allFindings.length === 0 ? (
          <div className="compact-empty">
            <Swords size={18} />
            <p>No adversarial findings have been recorded.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>Commitment</th>
                  <th>Review</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {[...allFindings]
                  .sort((first, second) => {
                    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
                    return (order[first.severity as keyof typeof order] ?? 3) -
                      (order[second.severity as keyof typeof order] ?? 3);
                  })
                  .map((finding) => (
                    <tr key={`${finding.reviewId}-${finding.code}-${finding.message}`}>
                      <td>
                        <StatusBadge
                          status={finding.severity}
                          label={finding.severity}
                          tone={severityTone(finding.severity)}
                        />
                      </td>
                      <td>
                        <div className="table-primary">
                          <strong>{finding.code.replaceAll("_", " ")}</strong>
                          <span className="subtle">{finding.message}</span>
                        </div>
                      </td>
                      <td>
                        <Link to={`/commitments/${finding.commitmentId}`} className="inline-link">
                          {commitments.find((item) => item.id === finding.commitmentId)?.title ||
                            shortId(finding.commitmentId, 16)}
                        </Link>
                      </td>
                      <td className="mono subtle">{finding.reviewId}</td>
                      <td>{formatDate(finding.created_at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function FindingCard({ finding }: { finding: AdversarialFinding }) {
  return (
    <div className={cx("finding-card", `finding-${severityTone(finding.severity)}`)}>
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
  );
}
