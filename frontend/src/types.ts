export type CommitmentStatus =
  | "EVIDENCE_PENDING"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "INVALIDATED"
  | string;

export interface Commitment {
  id: string;
  title: string;
  claim: string;
  owner: string;
  acceptance_criteria: string;
  status: CommitmentStatus;
  created_at: string;
}

export interface EvidenceRecord {
  id: string;
  commitment_id: string;
  filename: string;
  stored_path: string;
  sha256: string;
  created_at: string;
}

export interface CommitmentDetail {
  commitment: Commitment;
  evidence: EvidenceRecord[];
}

export interface PassportEvidence {
  evidence_id: string;
  filename: string;
  sha256: string;
  created_at: string;
  file_exists: boolean;
  current_sha256: string | null;
  integrity: "PASS" | "FAILED" | string;
}

export interface ProofCheck {
  id: string;
  commitment_id: string;
  evidence_id: string;
  name: string;
  operator: "contains" | "equals" | string;
  expected_value: string;
  created_at: string;
}

export interface ProofEvaluation {
  evaluation_id: string;
  result: "PASS" | "FAIL" | "INCONCLUSIVE" | string;
  details: Array<{
    check_id: string;
    name?: string;
    evidence_id: string;
    operator?: string;
    outcome: string;
    reason: string;
  }>;
  created_at: string;
}

export interface VerificationReview {
  review_id: string;
  result: "PASS" | "FAIL" | "INCONCLUSIVE" | string;
  reviewer_type?: string;
  details: {
    method?: string;
    results?: Array<{
      check_id: string;
      evidence_id: string;
      outcome: string;
      reason: string;
    }>;
    claim_semantically_verified?: boolean;
  };
  created_at: string;
}

export interface AdversarialFinding {
  severity: "CRITICAL" | "WARNING" | "INFO" | string;
  code: string;
  message: string;
}

export interface AdversarialReview {
  review_id: string;
  result: "CHALLENGED" | "LIMITATIONS_IDENTIFIED" | string;
  findings: AdversarialFinding[];
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  commitment_id: string;
  approver_id: string;
  decision: "APPROVE" | "REJECT" | string;
  reason: string;
  gate_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface TrustSummary {
  commitment_status: string;
  evidence_integrity: "INTACT" | "COLLAPSED" | "NOT_AVAILABLE" | string;
  proof_state: string;
  independent_review_state: string;
  adversarial_review_state: string;
  human_approval_state: string;
  claim_semantically_verified: boolean;
  limitations: string[];
}

export interface TrustPassport {
  passport_id: string;
  generated_at: string;
  passport_type: string;
  commitment: Commitment;
  evidence: PassportEvidence[];
  proof: {
    configured_checks: ProofCheck[];
    history: ProofEvaluation[];
    latest_result: string | null;
  };
  verification: {
    history: VerificationReview[];
    latest_result: string | null;
    method: string;
  };
  adversarial: {
    history: AdversarialReview[];
    latest_result: string | null;
    method: string;
  };
  approval: {
    history: ApprovalRecord[];
    latest_decision: string | null;
    approver_id: string | null;
  };
  audit_trail: AuditEvent[];
  trust_summary: TrustSummary;
  claim_semantically_verified: boolean;
}

export interface ReviewsResponse {
  independent_reviews: VerificationReview[];
  adversarial_reviews: AdversarialReview[];
}

export interface AuditEvent {
  id: string;
  commitment_id: string;
  event_type: string;
  details: Record<string, unknown> | unknown;
  created_at: string;
}

export interface GraphNode {
  id: string;
  type: "COMMITMENT" | "EVIDENCE" | "OWNER" | string;
  title?: string;
  name?: string;
  status?: string;
  filename?: string;
  sha256?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "OWNS" | "SUPPORTED_BY" | "DEPENDS_ON" | string;
}

export interface TrustGraphData {
  node_count?: number;
  edge_count?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProofResult {
  evaluation_id: string;
  commitment_id: string;
  result: string;
  claim_semantically_verified: boolean;
  evaluated_at: string;
  checks: Array<{
    check_id: string;
    name: string;
    evidence_id: string;
    operator: string;
    outcome: string;
    reason: string;
  }>;
  interpretation: string;
}

export interface IntegrityResult {
  commitment_id: string;
  evidence_integrity: string;
  commitment_status: string;
  claim_semantically_verified: boolean;
  results: Array<{
    evidence_id: string;
    integrity: string;
    reason?: string;
    expected_sha256?: string;
    actual_sha256?: string;
  }>;
  message: string;
}

export interface TrustScanResult {
  commitment_id: string;
  trust_status: "INTACT" | "COLLAPSED" | string;
  commitment_status: string;
  evidence_count: number;
  failed_evidence_count: number;
  affected_commitments: string[];
  results: Array<{
    evidence_id: string;
    filename: string;
    integrity: string;
    expected_sha256: string;
    actual_sha256: string | null;
    reason: string;
  }>;
  claim_semantically_verified: boolean;
  message: string;
}

export interface CommitmentBundle {
  commitment: Commitment;
  evidence: EvidenceRecord[];
  passport: TrustPassport | null;
  audit: AuditEvent[];
  reviews: ReviewsResponse | null;
  approvals: ApprovalRecord[];
}

export interface HealthState {
  status: "checking" | "online" | "offline";
  latencyMs: number | null;
  timestamp: string | null;
  lastCheckedAt: string | null;
}

export interface HealthResponse {
  status: string;
  database: boolean;
  timestamp: string;
}

export interface AgentsOverview {
  generated_at: string;
  commitments_observed: number;
  agents: AgentReport[];
}

export interface AgentFinding {
  severity: "CRITICAL" | "WARNING" | "INFO" | string;
  code: string;
  message: string;
}

export interface AgentReport {
  id: string;
  name: string;
  role: string;
  status: string;
  metrics: Record<string, unknown>;
  last_report: {
    report_type?: string;
    report_id?: string | null;
    review_id?: string | null;
    commitment_id?: string | null;
    commitment_title?: string | null;
    last_collapse_event_id?: string | null;
    generated_at: string;
    summary: string;
    findings: AgentFinding[];
    recommendations: string[];
  };
}

export interface DemoMutationResult {
  commitment_id: string;
  evidence_id: string;
  before_sha256: string;
  after_sha256: string;
  message: string;
}

export interface DependencyResult {
  dependency_id: string;
  commitment_id: string;
  depends_on_id: string;
  relationship: string;
  created_at: string;
}
