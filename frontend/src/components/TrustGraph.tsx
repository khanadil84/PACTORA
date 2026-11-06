import { useMemo, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { GraphEdge, GraphNode, TrustGraphData } from "../types";
import { cx } from "../lib/format";

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TrustGraphProps {
  graph: TrustGraphData | null;
  height?: number;
  compact?: boolean;
  selectedId?: string | null;
  impactRootId?: string | null;
  onSelectNode?: (node: GraphNode) => void;
}

const WIDTH = 940;
const GRAPH_PADDING = 54;

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function descendantsOf(rootId: string | null, edges: GraphEdge[]) {
  if (!rootId) return new Set<string>();

  const affected = new Set<string>([rootId]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const edge of edges) {
      if (edge.type === "DEPENDS_ON" && affected.has(edge.target) && !affected.has(edge.source)) {
        affected.add(edge.source);
        changed = true;
      }
    }
  }

  return affected;
}

export function TrustGraph({
  graph,
  height = 460,
  compact = false,
  selectedId,
  impactRootId,
  onSelectNode,
}: TrustGraphProps) {
  const [zoom, setZoom] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);

  const prepared = useMemo(() => {
    if (!graph) {
      return { nodes: [] as PositionedNode[], edges: [] as GraphEdge[] };
    }

    const nodes = compact
      ? graph.nodes.filter((node) => node.type !== "OWNER")
      : graph.nodes;
    const edges = graph.edges.filter((edge) => {
      if (compact) {
        return nodes.some((node) => node.id === edge.source) &&
          nodes.some((node) => node.id === edge.target);
      }
      return true;
    });

    const commitments = nodes.filter((node) => node.type === "COMMITMENT");
    const owners = nodes.filter((node) => node.type === "OWNER");
    const evidence = nodes.filter((node) => node.type === "EVIDENCE");

    const positions = new Map<string, PositionedNode>();
    const commitX = compact ? WIDTH * 0.34 : WIDTH * 0.48;
    const evidenceX = compact ? WIDTH * 0.76 : WIDTH * 0.79;
    const ownerX = WIDTH * 0.09;
    const usableHeight = height - GRAPH_PADDING * 2;

    const commitmentY = new Map<string, number>();

    commitments.forEach((node, index) => {
      const y =
        commitments.length === 1
          ? height / 2
          : GRAPH_PADDING + (usableHeight * index) / (commitments.length - 1);

      commitmentY.set(node.id, y);
      positions.set(node.id, {
        ...node,
        x: commitX,
        y,
        width: compact ? 172 : 196,
        height: 58,
      });
    });

    const evidenceByParent = new Map<string, GraphNode[]>();

    for (const item of evidence) {
      const edge = edges.find(
        (candidate) => candidate.type === "SUPPORTED_BY" && candidate.target === item.id,
      );
      const parent = edge?.source ?? "unattached";
      const group = evidenceByParent.get(parent) ?? [];
      group.push(item);
      evidenceByParent.set(parent, group);
    }

    for (const [parentId, items] of evidenceByParent) {
      const anchor = commitmentY.get(parentId) ?? height / 2;
      const spacing = 44;
      const start = anchor - ((items.length - 1) * spacing) / 2;

      items.forEach((item, index) => {
        positions.set(item.id, {
          ...item,
          x: evidenceX,
          y: start + index * spacing,
          width: compact ? 142 : 158,
          height: 32,
        });
      });
    }

    owners.forEach((node, index) => {
      const owned = edges
        .filter((edge) => edge.type === "OWNS" && edge.source === node.id)
        .map((edge) => commitmentY.get(edge.target))
        .filter((value): value is number => typeof value === "number");

      const y =
        owned.length > 0
          ? owned.reduce((sum, value) => sum + value, 0) / owned.length
          : GRAPH_PADDING + (usableHeight * index) / Math.max(owners.length - 1, 1);

      positions.set(node.id, {
        ...node,
        x: ownerX,
        y,
        width: 138,
        height: 30,
      });
    });

    return { nodes: Array.from(positions.values()), edges };
  }, [compact, edgesKey(graph), graph, height]);

  const impactSet = useMemo(
    () => descendantsOf(impactRootId ?? null, prepared.edges),
    [impactRootId, prepared.edges],
  );

  const activeId = hoveredId ?? selectedId ?? null;

  const connected = useMemo(() => {
    if (!activeId) return new Set<string>();

    const set = new Set<string>([activeId]);

    for (const edge of prepared.edges) {
      if (edge.source === activeId) set.add(edge.target);
      if (edge.target === activeId) set.add(edge.source);
    }

    return set;
  }, [activeId, prepared.edges]);

  if (!graph) {
    return (
      <div className="graph-empty" style={{ height }}>
        <span>Trust graph is loading.</span>
      </div>
    );
  }

  if (!prepared.nodes.length) {
    return (
      <div className="graph-empty" style={{ height }}>
        <span>No commitments are available to graph yet.</span>
      </div>
    );
  }

  return (
    <div className={cx("trust-graph", compact && "trust-graph-compact")}>
      <div className="graph-controls">
        <button
          className="icon-button graph-control"
          onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}
          aria-label="Zoom in"
        >
          <Plus size={14} />
        </button>
        <button
          className="icon-button graph-control"
          onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}
          aria-label="Zoom out"
        >
          <Minus size={14} />
        </button>
        <button
          className="icon-button graph-control"
          onClick={() => setZoom(1)}
          aria-label="Reset zoom"
        >
          <Maximize2 size={13} />
        </button>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="graph-svg"
        role="img"
        aria-label="Interactive PACTORA trust graph"
      >
        <defs>
          <marker id="arrow-depends" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-depends" />
          </marker>
          <marker id="arrow-owns" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-owns" />
          </marker>
          <filter id="graph-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g
          transform={`translate(${(1 - zoom) * (WIDTH / 2)} ${(1 - zoom) * (height / 2)}) scale(${zoom})`}
          className="graph-canvas"
        >
          {prepared.edges.map((edge, index) => {
            const source = prepared.nodes.find((node) => node.id === edge.source);
            const target = prepared.nodes.find((node) => node.id === edge.target);

            if (!source || !target) return null;

            const startX = source.x + source.width / 2;
            const startY = source.y;
            const endX = target.x - target.width / 2;
            const endY = target.y;
            const isDependency = edge.type === "DEPENDS_ON";
            const isActive =
              hoveredEdge === index ||
              (activeId !== null && (edge.source === activeId || edge.target === activeId));
            const isImpacted =
              isDependency && impactSet.has(edge.source) && impactSet.has(edge.target);

            const midX = (startX + endX) / 2;
            const path = isDependency
              ? `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
              : `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;

            return (
              <g key={`${edge.source}-${edge.target}-${index}`}>
                <path
                  d={path}
                  className={cx(
                    "graph-edge",
                    `edge-${edge.type.toLowerCase()}`,
                    isActive && "edge-active",
                    isImpacted && "edge-impacted",
                  )}
                  markerEnd={
                    edge.type === "DEPENDS_ON"
                      ? "url(#arrow-depends)"
                      : edge.type === "OWNS"
                        ? "url(#arrow-owns)"
                        : undefined
                  }
                />
                <path
                  d={path}
                  className="edge-hit"
                  onMouseEnter={() => setHoveredEdge(index)}
                  onMouseLeave={() => setHoveredEdge(null)}
                />
              </g>
            );
          })}

          {prepared.nodes.map((node) => {
            const isSelected = selectedId === node.id;
            const isConnected = connected.has(node.id);
            const isDimmed = activeId !== null && !isConnected;
            const isImpacted = impactSet.has(node.id);

            const label =
              node.type === "COMMITMENT"
                ? node.title || node.id
                : node.type === "EVIDENCE"
                  ? node.filename || node.id
                  : node.name || node.id;

            const status =
              node.type === "COMMITMENT"
                ? (node.status || "").toLowerCase()
                : "";

            return (
              <g
                key={node.id}
                className={cx(
                  "graph-node",
                  `node-${node.type.toLowerCase()}`,
                  status && `node-status-${status}`,
                  isSelected && "node-selected",
                  isImpacted && "node-impacted",
                  isDimmed && "node-dimmed",
                )}
                transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
                role={onSelectNode ? "button" : undefined}
                tabIndex={onSelectNode ? 0 : undefined}
                onClick={() => onSelectNode?.(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    onSelectNode?.(node);
                  }
                }}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <rect
                  width={node.width}
                  height={node.height}
                  rx={node.type === "COMMITMENT" ? 10 : 16}
                  className="node-surface"
                />
                <rect
                  width={4}
                  height={node.height - 16}
                  x={0}
                  y={8}
                  rx={2}
                  className="node-accent"
                />
                {node.type === "COMMITMENT" ? (
                  <>
                    <text x={14} y={22} className="node-title">
                      {truncate(label, 25)}
                    </text>
                    <text x={14} y={40} className="node-meta">
                      {truncate(node.id, 20)} · {(node.status || "UNKNOWN").replaceAll("_", " ")}
                    </text>
                  </>
                ) : node.type === "OWNER" ? (
                  <text x={12} y={19} className="node-owner">
                    {truncate(label, 19)}
                  </text>
                ) : (
                  <>
                    <text x={12} y={14} className="node-evidence-title">
                      {truncate(label, 22)}
                    </text>
                    <text x={12} y={25} className="node-meta">
                      {truncate(node.id, 18)}
                    </text>
                  </>
                )}
                {isSelected ? (
                  <circle cx={node.width - 12} cy={12} r={3} className="node-selected-dot" />
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-legend">
        <span><i className="legend-dot legend-owner" />Owner</span>
        <span><i className="legend-dot legend-commitment" />Commitment</span>
        <span><i className="legend-dot legend-evidence" />Evidence</span>
        <span><i className="legend-line legend-dependency" />Dependency</span>
      </div>
    </div>
  );
}

function edgesKey(graph: TrustGraphData | null) {
  if (!graph) return "";
  return graph.edges.map((edge) => `${edge.source}:${edge.target}:${edge.type}`).join("|");
}
