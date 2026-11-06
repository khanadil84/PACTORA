import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CircleAlert,
  GitBranch,
  Link2,
  Network,
  Plus,
  Radar,
  RefreshCw,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useData } from "../context/DataContext";
import {
  cx,
  formatDate,
  shortId,
  statusLabel,
} from "../lib/format";
import { TrustGraph } from "../components/TrustGraph";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  MetricCard,
  Modal,
  Notice,
  PageHeader,
  SectionHeading,
  Select,
  Skeleton,
  StatusBadge,
} from "../components/ui";
import type { GraphNode, TrustGraphData } from "../types";

function dependentsOf(rootId: string | null, graph: TrustGraphData | null) {
  if (!rootId || !graph) return [];

  const affected = new Set<string>([rootId]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const edge of graph.edges) {
      if (edge.type === "DEPENDS_ON" && affected.has(edge.target) && !affected.has(edge.source)) {
        affected.add(edge.source);
        changed = true;
      }
    }
  }

  return Array.from(affected).filter((id) => id !== rootId);
}

export function TrustGraphPage() {
  const { commitments, loading: portfolioLoading, refresh } = useData();
  const [graph, setGraph] = useState<TrustGraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impactRoot, setImpactRoot] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dependencyOpen, setDependencyOpen] = useState(false);
  const [dependency, setDependency] = useState({ commitment_id: "", depends_on_id: "" });
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);

    try {
      const result = await api.trustGraph();
      setGraph(result);
      setGraphError(null);
    } catch (caught) {
      setGraphError(
        caught instanceof ApiError ? caught.message : "Trust graph could not be loaded.",
      );
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) ?? null,
    [graph, selectedId],
  );

  const affected = useMemo(
    () => dependentsOf(impactRoot, graph),
    [impactRoot, graph],
  );

  const dependencyCount = useMemo(
    () => graph?.edges.filter((edge) => edge.type === "DEPENDS_ON").length ?? 0,
    [graph],
  );

  const selectedCommitment = commitments.find((item) => item.id === selectedNode?.id);

  const runScan = async () => {
    if (!selectedCommitment) return;

    setBusy("scan");
    setFeedback(null);

    try {
      const result = await api.trustScan(selectedCommitment.id);
      setImpactRoot(
        result.trust_status === "COLLAPSED" ? selectedCommitment.id : null,
      );
      await Promise.all([loadGraph(), refresh()]);
      setFeedback({
        tone: result.trust_status === "INTACT" ? "success" : "danger",
        text: `${result.message} Affected commitments: ${result.affected_commitments.length}.`,
      });
    } catch (caught) {
      setFeedback({
        tone: "danger",
        text: caught instanceof ApiError ? caught.message : "Trust scan failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const createDependency = async (event: FormEvent) => {
    event.preventDefault();
    setModalBusy(true);
    setModalError(null);

    if (dependency.commitment_id === dependency.depends_on_id) {
      setModalError("A commitment cannot depend on itself.");
      setModalBusy(false);
      return;
    }

    try {
      await api.createDependency(dependency.commitment_id, dependency.depends_on_id);
      await loadGraph();
      setDependencyOpen(false);
      setFeedback({
        tone: "success",
        text: "Dependency recorded. Trust collapse will now propagate from the prerequisite.",
      });
    } catch (caught) {
      setModalError(caught instanceof ApiError ? caught.message : "Dependency creation failed.");
    } finally {
      setModalBusy(false);
    }
  };

  if (portfolioLoading) {
    return (
      <div className="page-stack">
        <Skeleton className="skeleton-title" />
        <Skeleton className="skeleton-panel" />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Signature Capability"
        title="PACTORA Trust Graph"
        description="Commitments do not fail alone. Trace how evidence supports a claim, how commitments depend on one another, and how a single integrity collapse propagates through the network."
        actions={
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={() => void loadGraph()} loading={graphLoading}>
              Refresh graph
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setDependencyOpen(true)}>
              Add dependency
            </Button>
          </>
        }
      />

      <div className="metrics-grid metrics-grid-4">
        <MetricCard label="Graph nodes" value={graph?.node_count ?? "—"} detail="Commitments, owners and evidence" icon={Network} tone="info" />
        <MetricCard label="Relationships" value={graph?.edge_count ?? "—"} detail="Ownership, support and dependency" icon={Waypoints} tone="neutral" />
        <MetricCard label="Dependencies" value={dependencyCount} detail="Explicit dependency edges" icon={GitBranch} tone="info" />
        <MetricCard label="Impact preview" value={affected.length} detail="Transitive dependents of selected root" icon={CircleAlert} tone={affected.length ? "danger" : "neutral"} />
      </div>

      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      {graphError ? <ErrorState message={graphError} onRetry={() => void loadGraph()} /> : null}

      <div className="graph-page-grid">
        <Card className="graph-main-card">
          <SectionHeading
            title="Network topology"
            subtitle="Click any node to inspect it. Dependency edges are directional: the source commitment requires the target."
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setImpactRoot(impactRoot ? null : selectedId)}
                disabled={!selectedId}
              >
                {impactRoot ? "Clear impact" : "Preview collapse"}
              </Button>
            }
          />
          {graphLoading && !graph ? (
            <Skeleton className="skeleton-graph" />
          ) : (
            <TrustGraph
              graph={graph}
              height={520}
              selectedId={selectedId}
              impactRootId={impactRoot}
              onSelectNode={(node) => {
                setSelectedId(node.id);
                if (node.type !== "COMMITMENT") setImpactRoot(null);
              }}
            />
          )}
          {impactRoot ? (
            <div className="impact-banner">
              <CircleAlert size={16} />
              <span>
                Impact preview: if <strong>{shortId(impactRoot, 18)}</strong> collapses,
                {affected.length ? (
                  <>
                    {" "}
                    <strong>{affected.length}</strong> dependent commitment
                    {affected.length === 1 ? "" : "s"} become invalid.
                  </>
                ) : (
                  " no dependent commitments are recorded."
                )}
              </span>
            </div>
          ) : null}
        </Card>

        <div className="graph-side">
          <Card>
            <SectionHeading title="Node inspector" subtitle="Selected graph entity." />
            {!selectedNode ? (
              <div className="compact-empty">
                <Network size={18} />
                <p>Select a node in the graph to inspect it.</p>
              </div>
            ) : (
              <NodeInspector
                node={selectedNode}
                commitment={selectedCommitment}
                onPreviewImpact={() => setImpactRoot(selectedNode.id)}
                onRunScan={runScan}
                scanLoading={busy === "scan"}
              />
            )}
          </Card>

          <Card>
            <SectionHeading
              title="Collapse propagation"
              subtitle="Dependents reachable from the selected root."
            />
            {!impactRoot ? (
              <div className="compact-empty">
                <GitBranch size={18} />
                <p>Select a commitment and preview collapse to trace dependents.</p>
              </div>
            ) : affected.length === 0 ? (
              <div className="compact-empty">
                <ShieldCheck size={18} />
                <p>No dependent commitments are recorded for this root.</p>
              </div>
            ) : (
              <div className="impact-list">
                {affected.map((id) => {
                  const commitment = commitments.find((item) => item.id === id);

                  return (
                    <Link key={id} to={`/commitments/${id}`} className="impact-row">
                      <CircleAlert size={14} className="text-danger" />
                      <div>
                        <strong>{commitment?.title || shortId(id, 18)}</strong>
                        <span>{id}</span>
                      </div>
                      <StatusBadge
                        status={commitment?.status || "UNKNOWN"}
                        label={statusLabel(commitment?.status || "UNKNOWN")}
                        dot={false}
                      />
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {!graph?.nodes.length ? (
        <Card>
          <EmptyState
            icon={Network}
            title="The trust graph is empty"
            description="Create commitments and attach evidence to populate the network."
            action={
              <Link to="/commitments" className="button button-primary button-md">
                <Plus size={15} />
                <span>Create commitment</span>
              </Link>
            }
          />
        </Card>
      ) : null}

      <Modal
        open={dependencyOpen}
        onClose={() => setDependencyOpen(false)}
        title="Add commitment dependency"
        description="A dependency means the first commitment requires the second. Trust collapse propagates from the prerequisite to the dependent."
        wide
      >
        <form className="form-grid" onSubmit={createDependency}>
          <FormField label="Dependent commitment" hint="This commitment requires the prerequisite.">
            <Select
              value={dependency.commitment_id}
              onChange={(event) =>
                setDependency({ ...dependency, commitment_id: event.target.value })
              }
              required
            >
              <option value="">Select a commitment</option>
              {commitments.map((commitment) => (
                <option key={commitment.id} value={commitment.id}>
                  {commitment.title} · {commitment.id}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Prerequisite commitment" hint="If this commitment collapses, the dependent does too.">
            <Select
              value={dependency.depends_on_id}
              onChange={(event) =>
                setDependency({ ...dependency, depends_on_id: event.target.value })
              }
              required
            >
              <option value="">Select a commitment</option>
              {commitments
                .filter((commitment) => commitment.id !== dependency.commitment_id)
                .map((commitment) => (
                  <option key={commitment.id} value={commitment.id}>
                    {commitment.title} · {commitment.id}
                  </option>
                ))}
            </Select>
          </FormField>

          <Notice tone="warning" title="Propagation example">
            If <strong>{dependency.commitment_id || "Commitment A"}</strong> depends on{" "}
            <strong>{dependency.depends_on_id || "Commitment B"}</strong>, then an
            integrity failure in B will invalidate both A and B.
          </Notice>

          {modalError ? <div className="form-error" role="alert">{modalError}</div> : null}

          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setDependencyOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon={Link2} loading={modalBusy}>
              Record dependency
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function NodeInspector({
  node,
  commitment,
  onPreviewImpact,
  onRunScan,
  scanLoading,
}: {
  node: GraphNode;
  commitment: { id: string; title: string; status: string; owner: string; created_at: string } | undefined;
  onPreviewImpact: () => void;
  onRunScan: () => void;
  scanLoading: boolean;
}) {
  return (
    <div className="node-inspector">
      <div className="inspector-head">
        <span className={cx("inspector-type", `type-${node.type.toLowerCase()}`)}>
          {node.type}
        </span>
        {commitment ? (
          <StatusBadge
            status={commitment.status}
            label={statusLabel(commitment.status)}
          />
        ) : null}
      </div>

      <h3>{commitment?.title || node.title || node.name || node.filename || node.id}</h3>
      <div className="identity-value">
        <code>{node.id}</code>
      </div>

      {node.type === "COMMITMENT" && commitment ? (
        <>
          <div className="inspector-facts">
            <div>
              <span>Owner</span>
              <strong>{commitment.owner}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{formatDate(commitment.created_at)}</strong>
            </div>
          </div>
          <div className="inspector-actions">
            <Link to={`/commitments/${node.id}`} className="button button-secondary button-md">
              <ArrowRight size={15} />
              <span>Open commitment</span>
            </Link>
            <Button variant="ghost" onClick={onPreviewImpact}>
              <GitBranch size={15} />
              <span>Preview impact</span>
            </Button>
            <Button variant="ghost" icon={Radar} onClick={onRunScan} loading={scanLoading}>
              Run SENTINEL
            </Button>
          </div>
        </>
      ) : null}

      {node.type === "EVIDENCE" ? (
        <div className="inspector-facts">
          <div>
            <span>Filename</span>
            <strong>{node.filename}</strong>
          </div>
          <div>
            <span>SHA-256</span>
            <code className="inspector-hash">{node.sha256}</code>
          </div>
        </div>
      ) : null}

      {node.type === "OWNER" ? (
        <div className="inspector-facts">
          <div>
            <span>Principal</span>
            <strong>{node.name}</strong>
          </div>
        </div>
      ) : null}
    </div>
  );
}
