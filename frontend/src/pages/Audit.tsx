import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ChevronDown,
  CircleAlert,
  FileCheck2,
  FolderLock,
  History,
  Network,
  Search,
  ShieldCheck,
  Swords,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { useData } from "../context/DataContext";
import {
  cx,
  formatDate,
  relativeTime,
  shortId,
  statusLabel,
} from "../lib/format";
import {
  Card,
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  Select,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";

const EVENT_ICONS: Record<string, LucideIcon> = {
  COMMITMENT_CREATED: FileCheck2,
  EVIDENCE_ATTACHED: FolderLock,
  EVIDENCE_INTEGRITY_CHECK: ShieldCheck,
  PROOF_CHECKS_CREATED: FileCheck2,
  PROOF_EVALUATED: Activity,
  INDEPENDENT_REVIEW_COMPLETED: ShieldCheck,
  ADVERSARIAL_REVIEW_COMPLETED: Swords,
  HUMAN_APPROVAL_DECISION: UserCheck,
  TRUST_COLLAPSE_DETECTED: CircleAlert,
  DEPENDENCY_CREATED: Network,
  DEMO_EVIDENCE_TAMPERED: CircleAlert,
};

interface AuditRow {
  id: string;
  commitmentId: string;
  commitmentTitle: string;
  event_type: string;
  details: unknown;
  created_at: string;
}

function actorOf(details: unknown) {
  if (details && typeof details === "object" && "actor" in details) {
    const actor = (details as { actor?: { name?: string; role?: string } }).actor;
    return actor?.name || actor?.role || "system";
  }
  return "system";
}

function requestIdOf(details: unknown) {
  if (details && typeof details === "object" && "request_id" in details) {
    const value = (details as { request_id?: unknown }).request_id;
    return typeof value === "string" ? value : null;
  }
  return null;
}

export function Audit() {
  const { commitments, audits, loading, error, refresh } = useData();
  const [search, setSearch] = useState("");
  const [commitmentFilter, setCommitmentFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo<AuditRow[]>(
    () =>
      Object.entries(audits)
        .flatMap(([commitmentId, events]) =>
          events.map((event) => ({
            id: event.id,
            commitmentId,
            commitmentTitle:
              commitments.find((item) => item.id === commitmentId)?.title ||
              shortId(commitmentId, 18),
            event_type: event.event_type,
            details: event.details,
            created_at: event.created_at,
          })),
        )
        .sort(
          (first, second) =>
            new Date(second.created_at).getTime() -
            new Date(first.created_at).getTime(),
        ),
    [audits, commitments],
  );

  const eventTypes = useMemo(() => {
    const counts = rows.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.event_type] = (accumulator[row.event_type] ?? 0) + 1;
      return accumulator;
    }, {});

    return Object.entries(counts).sort((first, second) => second[1] - first[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesCommitment =
        commitmentFilter === "ALL" || row.commitmentId === commitmentFilter;
      const matchesType = typeFilter === "ALL" || row.event_type === typeFilter;
      const haystack = `${row.event_type} ${row.commitmentTitle} ${row.commitmentId} ${JSON.stringify(row.details)}`.toLowerCase();
      const matchesSearch = !normalized || haystack.includes(normalized);

      return matchesCommitment && matchesType && matchesSearch;
    });
  }, [commitmentFilter, rows, search, typeFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, AuditRow[]>();

    for (const row of filtered) {
      const date = new Date(row.created_at);
      const key = Number.isNaN(date.getTime())
        ? "Unknown date"
        : new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          }).format(date);

      const group = map.get(key) ?? [];
      group.push(row);
      map.set(key, group);
    }

    return Array.from(map.entries());
  }, [filtered]);

  const collapseEvents = rows.filter(
    (row) => row.event_type === "TRUST_COLLAPSE_DETECTED",
  ).length;
  const decisions = rows.filter(
    (row) => row.event_type === "HUMAN_APPROVAL_DECISION",
  ).length;

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Audit Timeline"
        title="The record does not forget."
        description="Every commitment event is preserved with its timestamp, actor and request metadata where supplied. This is the operational memory of the network."
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard label="Audit events" value={rows.length} detail="Across all commitments" icon={History} tone="info" />
        <MetricCard label="Event types" value={eventTypes.length} detail="Distinct recorded operations" icon={Activity} tone="neutral" />
        <MetricCard label="Human decisions" value={decisions} detail="Approvals and rejections" icon={UserCheck} tone="success" />
        <MetricCard label="Trust collapses" value={collapseEvents} detail="Integrity-driven invalidation" icon={CircleAlert} tone={collapseEvents ? "danger" : "success"} />
      </div>

      <Card>
        <div className="toolbar audit-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search events, actors, request IDs or details"
              aria-label="Search audit events"
            />
          </div>
          <Select
            value={commitmentFilter}
            onChange={(event) => setCommitmentFilter(event.target.value)}
            aria-label="Filter by commitment"
          >
            <option value="ALL">All commitments</option>
            {commitments.map((commitment) => (
              <option key={commitment.id} value={commitment.id}>
                {commitment.title}
              </option>
            ))}
          </Select>
          <Select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            aria-label="Filter by event type"
          >
            <option value="ALL">All event types</option>
            {eventTypes.map(([type, count]) => (
              <option key={type} value={type}>
                {statusLabel(type)} ({count})
              </option>
            ))}
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={History}
            title="No audit events match this view"
            description="Adjust the filters or create activity on a commitment."
          />
        ) : (
          <div className="audit-groups">
            {grouped.map(([day, events]) => (
              <section className="audit-day" key={day}>
                <div className="audit-day-head">
                  <span>{day}</span>
                  <span>{events.length} events</span>
                </div>
                <div className="audit-timeline">
                  {events.map((event) => {
                    const Icon = EVENT_ICONS[event.event_type] || Activity;
                    const isOpen = expanded.has(event.id);
                    const requestId = requestIdOf(event.details);
                    const actor = actorOf(event.details);

                    return (
                      <article className="audit-row" key={event.id}>
                        <div className="audit-marker">
                          <Icon size={15} />
                        </div>
                        <div className="audit-body">
                          <button className="audit-summary" onClick={() => toggle(event.id)}>
                            <div className="audit-head">
                              <strong>{statusLabel(event.event_type)}</strong>
                              <span>{formatDate(event.created_at)}</span>
                            </div>
                            <div className="audit-meta">
                              <Link
                                to={`/commitments/${event.commitmentId}`}
                                className="inline-link"
                                onClick={(clickEvent) => clickEvent.stopPropagation()}
                              >
                                {event.commitmentTitle}
                              </Link>
                              <span>{actor}</span>
                              <span>{relativeTime(event.created_at)}</span>
                              {requestId ? <span className="mono">{requestId}</span> : null}
                              <ChevronDown
                                size={14}
                                className={cx("audit-chevron", isOpen && "open")}
                              />
                            </div>
                          </button>
                          {isOpen ? (
                            <pre className="audit-payload">
                              {JSON.stringify(event.details, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>

      <div className="footer-strip">
        <StatusBadge status="INTACT" label="Append-only audit record" tone="info" dot={false} />
        <span>
          Events are ordered by backend timestamp. JSON payloads are shown
          exactly as persisted.
        </span>
      </div>
    </div>
  );
}
