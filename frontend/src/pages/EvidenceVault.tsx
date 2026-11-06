import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  FileWarning,
  FolderLock,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useData } from "../context/DataContext";
import { cx, formatDate, shortId } from "../lib/format";
import {
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  SkeletonPage,
  StatusBadge,
} from "../components/ui";

export function EvidenceVault() {
  const { commitments, details, passports, loading, error, refresh } = useData();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");

  const records = useMemo(
    () =>
      commitments.flatMap((commitment) => {
        const evidence = details[commitment.id]?.evidence ?? [];
        const passport = passports[commitment.id];

        return evidence.map((item) => {
          const passportEvidence = passport?.evidence.find(
            (candidate) => candidate.evidence_id === item.id,
          );

          return {
            ...item,
            commitmentTitle: commitment.title,
            commitmentStatus: commitment.status,
            integrity: passportEvidence?.integrity || "UNKNOWN",
            fileExists: passportEvidence?.file_exists ?? null,
            currentSha256: passportEvidence?.current_sha256 ?? null,
          };
        });
      }),
    [commitments, details, passports],
  );

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();

    return records.filter((item) => {
      const matchesSearch =
        !normalized ||
        item.filename.toLowerCase().includes(normalized) ||
        item.id.toLowerCase().includes(normalized) ||
        item.sha256.toLowerCase().includes(normalized) ||
        item.commitmentTitle.toLowerCase().includes(normalized);

      const matchesFilter =
        filter === "ALL" ||
        (filter === "INTACT" && item.integrity === "PASS") ||
        (filter === "FAILED" && item.integrity !== "PASS");

      return matchesSearch && matchesFilter;
    });
  }, [filter, records, search]);

  const intact = records.filter((item) => item.integrity === "PASS").length;
  const failed = records.length - intact;
  const missing = records.filter((item) => item.fileExists === false).length;

  if (loading) return <SkeletonPage />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Evidence Vault"
        title="Every artifact has a fingerprint."
        description="Evidence is stored under generated identifiers and re-hashed on demand. Any change to file bytes is detectable."
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard
          label="Evidence records"
          value={records.length}
          detail="Across all commitments"
          icon={FolderLock}
          tone="info"
        />
        <MetricCard
          label="Fingerprint verified"
          value={intact}
          detail="Current bytes match stored SHA-256"
          icon={CheckCircle2}
          tone="success"
        />
        <MetricCard
          label="Integrity failed"
          value={failed}
          detail="Changed or unreadable files"
          icon={FileWarning}
          tone={failed ? "danger" : "neutral"}
        />
        <MetricCard
          label="Files missing"
          value={missing}
          detail="Recorded evidence no longer on disk"
          icon={ShieldCheck}
          tone={missing ? "warning" : "neutral"}
        />
      </div>

      <Card>
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search filename, commitment, evidence ID or hash"
              aria-label="Search evidence"
            />
          </div>
          <div className="filter-chips">
            {[
              ["ALL", "All"],
              ["INTACT", "Verified"],
              ["FAILED", "Failed or missing"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={cx("filter-chip", filter === value && "filter-chip-active")}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={FolderLock}
            title="No evidence matches this view"
            description="Attach evidence from a commitment to populate the vault."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table evidence-table">
              <thead>
                <tr>
                  <th>Evidence</th>
                  <th>Commitment</th>
                  <th>SHA-256 fingerprint</th>
                  <th>Integrity</th>
                  <th>File</th>
                  <th>Stored</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="table-primary">
                        <strong>{item.filename}</strong>
                        <span className="mono subtle">{item.id}</span>
                      </div>
                    </td>
                    <td>
                      <Link to={`/commitments/${item.commitment_id}`} className="inline-link">
                        {item.commitmentTitle}
                      </Link>
                      <div className="mono subtle">{shortId(item.commitment_id, 18)}</div>
                    </td>
                    <td>
                      <div className="hash-cell">
                        <code title={item.sha256}>{item.sha256}</code>
                        <CopyButton value={item.sha256} />
                      </div>
                      {item.currentSha256 && item.currentSha256 !== item.sha256 ? (
                        <div className="hash-mismatch">
                          current: {item.currentSha256.slice(0, 16)}…
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge
                        status={item.integrity}
                        label={
                          item.integrity === "PASS"
                            ? "Verified"
                            : item.integrity === "FAILED"
                              ? "Failed"
                              : "Unknown"
                        }
                      />
                    </td>
                    <td>
                      {item.fileExists === null ? (
                        <span className="subtle">Unknown</span>
                      ) : item.fileExists ? (
                        <span className="text-success">Present</span>
                      ) : (
                        <span className="text-danger">Missing</span>
                      )}
                    </td>
                    <td>{formatDate(item.created_at)}</td>
                    <td>
                      <Link
                        to={`/commitments/${item.commitment_id}`}
                        className="row-link"
                        aria-label={`Open commitment ${item.commitment_id}`}
                      >
                        <ArrowRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="footer-strip">
        <ShieldCheck size={13} />
        <span>
          SHA-256 detects byte changes. It does not prove evidence authenticity,
          provenance or semantic truth.
        </span>
      </div>
    </div>
  );
}
