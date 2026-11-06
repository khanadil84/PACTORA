import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  ScanLine,
  ShieldCheck,
  Wand2,
  XCircle,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useData } from "../context/DataContext";
import { latestVerification } from "../lib/derive";
import { cx, formatDate, relativeTime, shortId, statusLabel, statusTone } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SectionHeading,
  Select,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";

export function Verification() {
  const { commitments, passports, reviews, loading, error, refresh } = useData();
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);

  useEffect(() => {
    if (!selectedId && commitments.length > 0) {
      setSelectedId(commitments[0].id);
    }
  }, [commitments, selectedId]);

  const commitment = commitments.find((item) => item.id === selectedId);
  const passport = selectedId ? passports[selectedId] : undefined;
  const reviewSet = selectedId ? reviews[selectedId] : undefined;
  const verification = latestVerification(reviewSet);
  const proofHistory = passport?.proof.history ?? [];

  const rows = useMemo(
    () =>
      commitments.map((item) => {
        const itemPassport = passports[item.id];
        const itemReview = reviews[item.id]?.independent_reviews?.[0];

        return {
          commitment: item,
          evidence: itemPassport?.trust_summary.evidence_integrity || "NOT_AVAILABLE",
          proof: itemPassport?.trust_summary.proof_state || "NOT_RUN",
          independent: itemReview?.result || "NOT_RUN",
          checkedAt: itemReview?.created_at || null,
        };
      }),
    [commitments, passports, reviews],
  );

  const execute = async (
    key: string,
    action: () => Promise<{ tone: "success" | "danger" | "warning"; text: string }>,
  ) => {
    setBusy(key);
    setFeedback(null);

    try {
      const result = await action();
      setFeedback(result);
      await refresh();
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "Verification action failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Verification Center"
        title="Independently re-run the proof."
        description="PACTORA separates file integrity, deterministic acceptance checks and independent re-verification. None of these steps is allowed to claim semantic truth."
      />

      <Card>
        <div className="selector-bar">
          <div>
            <span className="selector-label">Commitment</span>
            <Select
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setFeedback(null);
              }}
            >
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
              <Button
                icon={ShieldCheck}
                onClick={() =>
                  execute("verify", async () => {
                    const result = await api.verifyEvidence(commitment.id);
                    return {
                      tone: result.evidence_integrity === "PASS" ? "success" : "danger",
                      text: result.message,
                    };
                  })
                }
                loading={busy === "verify"}
              >
                Verify evidence
              </Button>
              <Button
                icon={Wand2}
                onClick={() =>
                  execute("evaluate", async () => {
                    const result = await api.evaluate(commitment.id);
                    return {
                      tone: result.result === "PASS" ? "success" : result.result === "FAIL" ? "danger" : "warning",
                      text: result.interpretation,
                    };
                  })
                }
                loading={busy === "evaluate"}
              >
                Evaluate proof
              </Button>
              <Button
                variant="primary"
                icon={CheckCircle2}
                onClick={() =>
                  execute("independent", async () => {
                    const result = await api.independentReview(commitment.id);
                    return {
                      tone: result.result === "PASS" ? "success" : "danger",
                      text: `Independent review ${result.review_id}: ${result.result}.`,
                    };
                  })
                }
                loading={busy === "independent"}
              >
                Independent review
              </Button>
            </div>
          ) : null}
        </div>

        {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      </Card>

      {!commitment ? (
        <EmptyState
          icon={FileCheck2}
          title="No commitment selected"
          description="Create a commitment and attach evidence to begin verification."
        />
      ) : (
        <div className="verification-grid">
          <Card>
            <SectionHeading
              title="Configured proof checks"
              subtitle="Bound to explicit evidence records. Evaluation refuses untrusted file content."
            />
            {passport?.proof.configured_checks.length ? (
              <div className="check-list">
                {passport.proof.configured_checks.map((check) => {
                  const latest = proofHistory[0]?.details.find(
                    (item) => item.check_id === check.id,
                  );

                  return (
                    <div className="check-row" key={check.id}>
                      <div>
                        <strong>{check.name}</strong>
                        <span className="mono subtle">
                          {check.operator} “{check.expected_value}”
                        </span>
                      </div>
                      <StatusBadge
                        status={latest?.outcome || "NOT_RUN"}
                        label={latest ? statusLabel(latest.outcome) : "Not run"}
                      />
                      <p>{latest?.reason || "Configured but not yet evaluated."}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="compact-empty">
                <FileCheck2 size={18} />
                <p>No deterministic checks are configured for this commitment.</p>
              </div>
            )}

            <SectionHeading title="Evaluation history" subtitle="Re-evaluating does not trust earlier results." />
            {proofHistory.length ? (
              <div className="history-list">
                {proofHistory.map((evaluation) => (
                  <div className="history-row" key={evaluation.evaluation_id}>
                    <StatusBadge status={evaluation.result} label={statusLabel(evaluation.result)} />
                    <div>
                      <strong className="mono">{evaluation.evaluation_id}</strong>
                      <span>{formatDate(evaluation.created_at)}</span>
                    </div>
                    <span className="subtle">{evaluation.details.length} checks</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="subtle">No proof evaluations recorded.</p>
            )}
          </Card>

          <Card>
            <SectionHeading
              title="Independent verification"
              subtitle="A deterministic recheck under a separate reviewer identity."
              action={
                verification ? (
                  <StatusBadge status={verification.result} label={statusLabel(verification.result)} />
                ) : null
              }
            />
            {verification ? (
              <div className="verification-latest">
                <div className="verification-headline">
                  {verification.result === "PASS" ? (
                    <CheckCircle2 size={20} className="text-success" />
                  ) : (
                    <XCircle size={20} className="text-danger" />
                  )}
                  <div>
                    <strong>{verification.review_id}</strong>
                    <span>
                      {formatDate(verification.created_at)} · {relativeTime(verification.created_at)}
                    </span>
                  </div>
                </div>
                <div className="verification-checks">
                  {(verification.details.results ?? []).map((result) => (
                    <div key={result.check_id} className="verification-check">
                      <StatusBadge status={result.outcome} label={result.outcome} dot={false} />
                      <span className="mono subtle">{result.check_id}</span>
                      <span>{result.reason}</span>
                    </div>
                  ))}
                </div>
                <Notice tone="warning" title="Scope limitation">
                  This independent review re-ran configured checks. It did not
                  independently establish the semantic truth of “{commitment.claim}”.
                </Notice>
              </div>
            ) : (
              <div className="compact-empty">
                <ShieldCheck size={18} />
                <p>No independent verification has been recorded for this commitment.</p>
              </div>
            )}

            <div className="inline-facts">
              <div>
                <span>Review history</span>
                <strong>{reviewSet?.independent_reviews.length ?? 0}</strong>
              </div>
              <div>
                <span>Evidence integrity</span>
                <strong>{statusLabel(passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE")}</strong>
              </div>
              <div>
                <span>Semantic verification</span>
                <strong className="text-warning">False</strong>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <SectionHeading
          title="Portfolio verification matrix"
          subtitle="Current integrity, proof and independent-review state for every commitment."
          action={
            <Link to="/graph" className="text-link">
              Trace dependencies <ArrowRight size={14} />
            </Link>
          }
        />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Commitment</th>
                <th>Evidence integrity</th>
                <th>Proof</th>
                <th>Independent review</th>
                <th>Last checked</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.commitment.id}>
                  <td>
                    <div className="table-primary">
                      <strong>{row.commitment.title}</strong>
                      <span className="mono subtle">{shortId(row.commitment.id, 16)}</span>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={row.evidence} label={statusLabel(row.evidence)} />
                  </td>
                  <td>
                    <StatusBadge status={row.proof} label={statusLabel(row.proof)} />
                  </td>
                  <td>
                    <span className={cx("text-" + statusTone(row.independent))}>
                      {statusLabel(row.independent)}
                    </span>
                  </td>
                  <td>{row.checkedAt ? formatDate(row.checkedAt) : <span className="subtle">Not run</span>}</td>
                  <td>
                    <Link to={`/commitments/${row.commitment.id}`} className="row-link">
                      <ArrowRight size={15} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="footer-strip">
        <ScanLine size={13} />
        <span>
          Verification is deterministic. It does not perform semantic reasoning
          over the business claim.
        </span>
      </div>
    </div>
  );
}
