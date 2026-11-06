import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CircleAlert,
  FileCheck2,
  Filter,
  Plus,
  Search,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useData } from "../context/DataContext";
import { commitmentHealth } from "../lib/derive";
import { cx, formatDate, relativeTime, shortId, statusLabel } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  MetricCard,
  Modal,
  PageHeader,
  Select,
  SkeletonPage,
  StatusBadge,
  TextInput,
  TextArea,
} from "../components/ui";

const STATUS_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "APPROVED", label: "Approved" },
  { id: "UNDER_REVIEW", label: "Under review" },
  { id: "EVIDENCE_PENDING", label: "Evidence pending" },
  { id: "INVALIDATED", label: "Invalidated" },
  { id: "REJECTED", label: "Rejected" },
];

interface CreateForm {
  title: string;
  claim: string;
  owner: string;
  acceptance_criteria: string;
}

const EMPTY_FORM: CreateForm = {
  title: "",
  claim: "",
  owner: "Security Engineering",
  acceptance_criteria: "",
};

export function Commitments() {
  const { commitments, details, passports, loading, error, refresh } = useData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sort, setSort] = useState("newest");
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();

    const rows = commitments.filter((commitment) => {
      const matchesStatus =
        statusFilter === "ALL" || commitment.status === statusFilter;
      const matchesSearch =
        !normalized ||
        commitment.title.toLowerCase().includes(normalized) ||
        commitment.claim.toLowerCase().includes(normalized) ||
        commitment.owner.toLowerCase().includes(normalized) ||
        commitment.id.toLowerCase().includes(normalized);

      return matchesStatus && matchesSearch;
    });

    return rows.sort((first, second) => {
      if (sort === "title") return first.title.localeCompare(second.title);
      if (sort === "status") return first.status.localeCompare(second.status);

      const firstDate = new Date(first.created_at).getTime();
      const secondDate = new Date(second.created_at).getTime();

      return sort === "oldest" ? firstDate - secondDate : secondDate - firstDate;
    });
  }, [commitments, search, sort, statusFilter]);

  const stats = useMemo(() => {
    const approved = commitments.filter((item) => item.status === "APPROVED").length;
    const invalidated = commitments.filter((item) => item.status === "INVALIDATED").length;
    const pending = commitments.filter(
      (item) => item.status === "UNDER_REVIEW" || item.status === "EVIDENCE_PENDING",
    ).length;

    return { approved, invalidated, pending };
  }, [commitments]);

  const createCommitment = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);

    try {
      const result = await api.createCommitment(form);
      await refresh();
      setModalOpen(false);
      setForm(EMPTY_FORM);
      navigate(`/commitments/${result.commitment_id}`);
    } catch (caught) {
      setCreateError(
        caught instanceof ApiError ? caught.message : "Commitment creation failed.",
      );
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Commitment Center"
        title="Every promise must carry proof."
        description="Create business commitments, attach evidence, run verification gates and track trust state through approval and monitoring."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
            New commitment
          </Button>
        }
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard
          label="Total commitments"
          value={commitments.length}
          detail="Across all business owners"
          icon={FileCheck2}
          tone="info"
        />
        <MetricCard
          label="Approved"
          value={stats.approved}
          detail="Passed every assurance gate"
          icon={UserCheck}
          tone="success"
        />
        <MetricCard
          label="Awaiting review"
          value={stats.pending}
          detail="Open verification or approval work"
          icon={ShieldCheck}
          tone="warning"
        />
        <MetricCard
          label="Invalidated"
          value={stats.invalidated}
          detail="Locked by trust collapse"
          icon={CircleAlert}
          tone={stats.invalidated ? "danger" : "neutral"}
        />
      </div>

      <Card>
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by title, claim, owner or ID"
              aria-label="Search commitments"
            />
          </div>

          <div className="filter-chips" role="group" aria-label="Filter by status">
            <Filter size={14} className="filter-icon" />
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={cx(
                  "filter-chip",
                  statusFilter === filter.id && "filter-chip-active",
                )}
                onClick={() => setStatusFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            aria-label="Sort commitments"
            className="sort-select"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
            <option value="status">Status</option>
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={FileCheck2}
            title="No commitments match this view"
            description="Adjust the search or status filter, or create a new commitment to begin the assurance workflow."
            action={
              <Button variant="secondary" icon={Plus} onClick={() => setModalOpen(true)}>
                Create commitment
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Commitment</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Evidence</th>
                  <th>Trust index</th>
                  <th>Created</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((commitment) => {
                  const passport = passports[commitment.id];
                  const evidence = details[commitment.id]?.evidence ?? [];
                  const health = commitmentHealth(commitment, passport);
                  const integrity = passport?.trust_summary.evidence_integrity;

                  return (
                    <tr
                      key={commitment.id}
                      className="clickable-row"
                      onClick={() => navigate(`/commitments/${commitment.id}`)}
                    >
                      <td>
                        <div className="table-primary">
                          <strong>{commitment.title}</strong>
                          <span className="subtle mono">{shortId(commitment.id, 18)}</span>
                        </div>
                      </td>
                      <td>
                        <span className="owner-cell">{commitment.owner}</span>
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
                              ? "Verified"
                              : integrity === "COLLAPSED"
                                ? "Collapsed"
                                : "Not verified"}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="trust-cell">
                          <div className="trust-meter">
                            <span style={{ width: `${Math.round(health * 100)}%` }} />
                          </div>
                          <span>{Math.round(health * 100)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="table-primary">
                          <span>{formatDate(commitment.created_at)}</span>
                          <span className="subtle">
                            {relativeTime(commitment.created_at)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <Link
                          to={`/commitments/${commitment.id}`}
                          className="row-link"
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Open ${commitment.title}`}
                        >
                          <ArrowRight size={15} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create a commitment"
        description="State the business claim and the acceptance criteria that will govern verification."
        wide
      >
        <form className="form-grid" onSubmit={createCommitment}>
          <FormField label="Title">
            <TextInput
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Customer Data Encryption"
              minLength={3}
              maxLength={150}
              required
            />
          </FormField>

          <FormField label="Owner">
            <TextInput
              value={form.owner}
              onChange={(event) => setForm({ ...form, owner: event.target.value })}
              placeholder="Security Engineering"
              minLength={2}
              maxLength={100}
              required
            />
          </FormField>

          <FormField
            label="Business claim"
            hint="The precise statement that PACTORA will not treat as semantically proven."
          >
            <TextArea
              value={form.claim}
              onChange={(event) => setForm({ ...form, claim: event.target.value })}
              placeholder="Customer data is encrypted at rest."
              minLength={5}
              maxLength={2000}
              rows={3}
              required
            />
          </FormField>

          <FormField
            label="Acceptance criteria"
            hint="What evidence and deterministic checks must demonstrate."
          >
            <TextArea
              value={form.acceptance_criteria}
              onChange={(event) =>
                setForm({ ...form, acceptance_criteria: event.target.value })
              }
              placeholder="Approved storage configuration demonstrates encryption enabled."
              minLength={5}
              maxLength={2000}
              rows={3}
              required
            />
          </FormField>

          {createError ? (
            <div className="form-error" role="alert">
              {createError}
            </div>
          ) : null}

          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={creating} icon={Plus}>
              Create commitment
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
