import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Lock,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { api, ApiError, APPROVAL_TOKEN, APPROVER_ID } from "../api";
import { useData } from "../context/DataContext";
import { approvalBlockers, latestAdversarial, latestVerification } from "../lib/derive";
import { cx, formatDate, relativeTime, shortId, statusLabel, statusTone } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  MetricCard,
  Notice,
  PageHeader,
  SectionHeading,
  Select,
  SkeletonPage,
  StatusBadge,
  TextArea,
  TextInput,
} from "../components/ui";

export function Approvals() {
  const { commitments, passports, reviews, loading, error, refresh } = useData();
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState({
    approver_id: APPROVER_ID,
    decision: "APPROVE" as "APPROVE" | "REJECT",
    reason: "All configured assurance gates passed against current evidence.",
    token: APPROVAL_TOKEN,
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);

  useEffect(() => {
    if (!selectedId) {
      const next = commitments.find(
        (item) => item.status === "UNDER_REVIEW" || item.status === "EVIDENCE_PENDING",
      );
      if (next) setSelectedId(next.id);
      else if (commitments.length > 0) setSelectedId(commitments[0].id);
    }
  }, [commitments, selectedId]);

  const commitment = commitments.find((item) => item.id === selectedId);
  const passport = selectedId ? passports[selectedId] : undefined;
  const reviewSet = selectedId ? reviews[selectedId] : undefined;
  const blockers = commitment ? approvalBlockers(commitment, passport) : [];
  const verification = latestVerification(reviewSet);
  const adversarial = latestAdversarial(reviewSet);

  const queue = useMemo(
    () =>
      commitments
        .filter((item) => item.status !== "APPROVED" && item.status !== "INVALIDATED")
        .sort((first, second) => {
          const rank = (status: string) => (status === "UNDER_REVIEW" ? 0 : 1);
          return rank(first.status) - rank(second.status);
        }),
    [commitments],
  );

  const history = useMemo(
    () =>
      Object.entries(passports)
        .flatMap(([commitmentId, item]) =>
          (item.approval.history ?? []).map((record) => ({
            ...record,
            commitmentTitle:
              commitments.find((candidate) => candidate.id === commitmentId)?.title ||
              shortId(commitmentId, 16),
            commitmentId,
          })),
        )
        .sort(
          (first, second) =>
            new Date(second.created_at).getTime() - new Date(first.created_at).getTime(),
        ),
    [commitments, passports],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!commitment) return;

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.approval(
        commitment.id,
        {
          approver_id: form.approver_id,
          decision: form.decision,
          reason: form.reason,
        },
        form.token,
      );
      await refresh();
      setFeedback({
        tone: result.decision === "APPROVE" ? "success" : "warning",
        text: `${result.approval_id} recorded ${result.decision}. Commitment status: ${result.status}.`,
      });
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "The approval decision failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const gates = [
    {
      label: "Evidence integrity",
      value: passport?.trust_summary.evidence_integrity || "NOT_AVAILABLE",
    },
    { label: "Deterministic proof", value: passport?.trust_summary.proof_state || "NOT_RUN" },
    {
      label: "Independent review",
      value: verification?.result || "NOT_RUN",
    },
    {
      label: "Adversarial review",
      value: adversarial?.result || "NOT_RUN",
    },
    {
      label: "Evidence snapshot freshness",
      value:
        verification && adversarial
          ? "Verify at decision"
          : "Reviews incomplete",
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Human Approval Center"
        title="A machine cannot account for a promise."
        description="Technical gates inform the decision, but only an authorized human can make it. The backend re-checks evidence integrity and review freshness at the moment of approval."
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard
          label="Awaiting decision"
          value={queue.length}
          detail="Open commitments in the queue"
          icon={UserCheck}
          tone="warning"
        />
        <MetricCard
          label="Approved"
          value={commitments.filter((item) => item.status === "APPROVED").length}
          detail="Recorded human approvals"
          icon={BadgeCheck}
          tone="success"
        />
        <MetricCard
          label="Rejected"
          value={commitments.filter((item) => item.status === "REJECTED").length}
          detail="Accountable negative decisions"
          icon={XCircle}
          tone="neutral"
        />
        <MetricCard
          label="Locked"
          value={commitments.filter((item) => item.status === "INVALIDATED").length}
          detail="Invalidated commitments cannot be approved"
          icon={Lock}
          tone="danger"
        />
      </div>

      <div className="approval-grid">
        <Card>
          <SectionHeading
            title="Decision queue"
            subtitle="Select a commitment to review its gates and record a decision."
          />
          {queue.length === 0 ? (
            <div className="compact-empty">
              <CheckCircle2 size={18} />
              <p>No commitments are waiting for a decision.</p>
            </div>
          ) : (
            <div className="approval-queue">
              {queue.map((item) => {
                const itemBlockers = approvalBlockers(item, passports[item.id]);

                return (
                  <button
                    key={item.id}
                    className={cx(
                      "approval-queue-item",
                      selectedId === item.id && "approval-queue-item-active",
                    )}
                    onClick={() => {
                      setSelectedId(item.id);
                      setFeedback(null);
                    }}
                  >
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.owner} · {shortId(item.id, 16)}</span>
                    </div>
                    <div className="queue-item-side">
                      <StatusBadge status={item.status} label={statusLabel(item.status)} />
                      <span className={cx("queue-blockers", itemBlockers.length ? "text-warning" : "text-success")}>
                        {itemBlockers.length
                          ? `${itemBlockers.length} blocker${itemBlockers.length === 1 ? "" : "s"}`
                          : "Ready for decision"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          {!commitment ? (
            <EmptyState
              icon={UserCheck}
              title="No commitment selected"
              description="Select a commitment from the queue to review its assurance gates."
            />
          ) : (
            <>
              <SectionHeading
                title={commitment.title}
                subtitle={`${commitment.owner} · ${commitment.id}`}
                action={
                  <Link to={`/commitments/${commitment.id}`} className="text-link">
                    Detail <ArrowRight size={14} />
                  </Link>
                }
              />

              {commitment.status === "INVALIDATED" ? (
                <Notice tone="danger" title="Commitment locked">
                  Invalidated commitments require an authorized re-attestation
                  workflow. Approval and rejection are blocked by the backend.
                </Notice>
              ) : null}

              <div className="gate-checklist">
                {gates.map((gate) => (
                  <div className="gate-check" key={gate.label}>
                    <div>
                      <span>{gate.label}</span>
                      <strong>{statusLabel(gate.value)}</strong>
                    </div>
                    <span className={cx("gate-state", `text-${statusTone(gate.value)}`)}>
                      {statusLabel(gate.value)}
                    </span>
                  </div>
                ))}
              </div>

              {blockers.length ? (
                <Notice tone="warning" title="Approval blocked">
                  <ul className="tight-list">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                  A rejection may still be recorded.
                </Notice>
              ) : (
                <Notice tone="success" title="Visible gates satisfied">
                  The backend will re-check current evidence and review snapshots
                  before accepting approval.
                </Notice>
              )}

              <form className="form-grid approval-form" onSubmit={submit}>
                <div className="form-row">
                  <FormField label="Approver ID">
                    <TextInput
                      value={form.approver_id}
                      onChange={(event) => setForm({ ...form, approver_id: event.target.value })}
                      required
                    />
                  </FormField>
                  <FormField label="Decision">
                    <Select
                      value={form.decision}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          decision: event.target.value as "APPROVE" | "REJECT",
                        })
                      }
                    >
                      <option value="APPROVE">Approve</option>
                      <option value="REJECT">Reject</option>
                    </Select>
                  </FormField>
                </div>

                <FormField label="Reason">
                  <TextArea
                    value={form.reason}
                    onChange={(event) => setForm({ ...form, reason: event.target.value })}
                    rows={3}
                    minLength={5}
                    required
                  />
                </FormField>

                <FormField
                  label="Approval token"
                  hint="Local demo authorization token. A production deployment would use a separate approver identity flow."
                >
                  <TextInput
                    type="password"
                    value={form.token}
                    onChange={(event) => setForm({ ...form, token: event.target.value })}
                    required
                  />
                </FormField>

                {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}

                <div className="modal-actions">
                  {commitment.status === "UNDER_REVIEW" || commitment.status === "EVIDENCE_PENDING" ? (
                    <Button
                      type="submit"
                      variant={form.decision === "APPROVE" ? "success" : "danger"}
                      icon={form.decision === "APPROVE" ? CheckCircle2 : XCircle}
                      loading={busy}
                    >
                      Record {form.decision === "APPROVE" ? "approval" : "rejection"}
                    </Button>
                  ) : (
                    <Button type="button" variant="secondary" disabled icon={ShieldCheck}>
                      Decision already recorded
                    </Button>
                  )}
                </div>
              </form>
            </>
          )}
        </Card>
      </div>

      <Card>
        <SectionHeading
          title="Approval history"
          subtitle="Every decision preserves the gate snapshot that was evaluated."
        />
        {history.length === 0 ? (
          <div className="compact-empty">
            <UserCheck size={18} />
            <p>No human decisions have been recorded.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Commitment</th>
                  <th>Approver</th>
                  <th>Reason</th>
                  <th>Gate snapshot</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {history.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <StatusBadge
                        status={record.decision}
                        label={record.decision}
                        tone={record.decision === "APPROVE" ? "success" : "danger"}
                      />
                    </td>
                    <td>
                      <Link to={`/commitments/${record.commitment_id}`} className="inline-link">
                        {record.commitmentTitle}
                      </Link>
                    </td>
                    <td>{record.approver_id}</td>
                    <td>
                      <span className="truncate-cell" title={record.reason}>{record.reason}</span>
                    </td>
                    <td>
                      <span className="mono subtle">
                        {Object.keys(record.gate_snapshot ?? {}).length} gate fields
                      </span>
                    </td>
                    <td>
                      <div className="table-primary">
                        <span>{formatDate(record.created_at)}</span>
                        <span className="subtle">{relativeTime(record.created_at)}</span>
                      </div>
                    </td>
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
