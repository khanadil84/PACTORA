import type {
  AgentsOverview,
  AdversarialReview,
  ApprovalRecord,
  AuditEvent,
  Commitment,
  CommitmentDetail,
  DemoMutationResult,
  DependencyResult,
  EvidenceRecord,
  HealthResponse,
  IntegrityResult,
  ProofCheck,
  ProofEvaluation,
  ProofResult,
  ReviewsResponse,
  TrustGraphData,
  TrustPassport,
  TrustScanResult,
  VerificationReview,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");
const API_KEY =
  import.meta.env.VITE_PACTORA_API_KEY || "pactora-local-demo-7f3c9a";

export const APPROVER_ID =
  import.meta.env.VITE_PACTORA_APPROVER_ID || "security.manager";
export const APPROVAL_TOKEN =
  import.meta.env.VITE_PACTORA_APPROVAL_TOKEN ||
  "pactora-approval-local-demo";

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function detailToMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "msg" in item) {
          return String((item as { msg: unknown }).msg);
        }
        return JSON.stringify(item);
      })
      .join(" · ");
  }

  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    return JSON.stringify(record);
  }

  return "The request could not be completed.";
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-API-Key", API_KEY);

  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      "Cannot reach the PACTORA backend. Confirm the API is running on port 8000.",
      null,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? (body as { detail: unknown }).detail
        : body;

    throw new ApiError(
      response.status,
      detailToMessage(detail),
      detail,
    );
  }

  return body as T;
}

function post<T>(path: string, body?: unknown, headers?: Record<string, string>) {
  return request<T>(
    path,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    headers,
  );
}

export interface CreateCommitmentInput {
  title: string;
  claim: string;
  owner: string;
  acceptance_criteria: string;
}

export interface AttachEvidenceInput {
  filename: string;
  content: string;
}

export interface ProofCheckInput {
  evidence_id: string;
  name: string;
  operator: "contains" | "equals";
  expected_value: string;
}

export const api = {
  health: () => request<HealthResponse>("/health"),

  listCommitments: () => request<Commitment[]>("/commitments"),

  createCommitment: (input: CreateCommitmentInput) =>
    post<{ commitment_id: string; status: string; message: string }>(
      "/commitments",
      input,
    ),

  getCommitment: (id: string) =>
    request<CommitmentDetail>(`/commitments/${encodeURIComponent(id)}`),

  attachEvidence: (id: string, input: AttachEvidenceInput) =>
    post<{
      evidence_id: string;
      sha256: string;
      status: string;
      message: string;
    }>(`/commitments/${encodeURIComponent(id)}/evidence`, input),

  verifyEvidence: (id: string) =>
    post<IntegrityResult>(`/commitments/${encodeURIComponent(id)}/verify`),

  getAudit: (id: string) =>
    request<AuditEvent[]>(`/commitments/${encodeURIComponent(id)}/audit`),

  createProofChecks: (id: string, checks: ProofCheckInput[]) =>
    post<{
      commitment_id: string;
      checks_created: number;
      checks: Array<{ check_id: string; name: string; operator: string; evidence_id: string }>;
    }>(`/commitments/${encodeURIComponent(id)}/proof-checks`, { checks }),

  evaluate: (id: string) =>
    post<ProofResult>(`/commitments/${encodeURIComponent(id)}/evaluate`),

  proofHistory: (id: string) =>
    request<ProofEvaluation[]>(
      `/commitments/${encodeURIComponent(id)}/proof-history`,
    ),

  independentReview: (id: string) =>
    post<VerificationReview & { details: VerificationReview["details"] }>(
      `/commitments/${encodeURIComponent(id)}/independent-review`,
    ),

  adversarialReview: (id: string) =>
    post<AdversarialReview>(
      `/commitments/${encodeURIComponent(id)}/adversarial-review`,
    ),

  reviews: (id: string) =>
    request<ReviewsResponse>(`/commitments/${encodeURIComponent(id)}/reviews`),

  approval: (
    id: string,
    input: { approver_id: string; decision: "APPROVE" | "REJECT"; reason: string },
    token: string,
  ) =>
    post<{
      approval_id: string;
      commitment_id: string;
      approver_id: string;
      decision: string;
      status: string;
      gates: Record<string, unknown>;
      created_at: string;
    }>(`/commitments/${encodeURIComponent(id)}/approval`, input, {
      "X-Approval-Token": token,
    }),

  approvalHistory: (id: string) =>
    request<ApprovalRecord[]>(
      `/commitments/${encodeURIComponent(id)}/approval-history`,
    ),

  trustScan: (id: string) =>
    post<TrustScanResult>(`/commitments/${encodeURIComponent(id)}/trust-scan`),

  trustPassport: (id: string) =>
    request<TrustPassport>(
      `/commitments/${encodeURIComponent(id)}/trust-passport`,
    ),

  createDependency: (id: string, dependsOnId: string) =>
    post<DependencyResult>(
      `/commitments/${encodeURIComponent(id)}/dependencies`,
      { depends_on_id: dependsOnId },
    ),

  trustGraph: () => request<TrustGraphData>("/trust-graph"),

  commitmentTrustGraph: (id: string) =>
    request<TrustGraphData>(
      `/commitments/${encodeURIComponent(id)}/trust-graph`,
    ),

  agentsOverview: () => request<AgentsOverview>("/agents/overview"),

  demoTamper: (id: string) =>
    post<DemoMutationResult>(
      `/demo/commitments/${encodeURIComponent(id)}/tamper`,
    ),
};

export type {
  Commitment,
  CommitmentDetail,
  EvidenceRecord,
  ProofCheck,
};
