export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Not recorded";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDay(value: string | null | undefined) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(date);
}

export function relativeTime(value: string | null | undefined) {
  if (!value) return "never";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute < 45) return "just now";

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (absolute < 3_600) {
    return formatter.format(Math.round(seconds / 60), "minute");
  }

  if (absolute < 86_400) {
    return formatter.format(Math.round(seconds / 3_600), "hour");
  }

  if (absolute < 2_592_000) {
    return formatter.format(Math.round(seconds / 86_400), "day");
  }

  return formatter.format(Math.round(seconds / 2_592_000), "month");
}

export function shortId(value: string, size = 12) {
  if (!value) return "—";
  if (value.length <= size) return value;
  return `${value.slice(0, size)}…`;
}

export function shortHash(value: string | null | undefined, size = 10) {
  if (!value) return "—";
  return `${value.slice(0, size)}…${value.slice(-4)}`;
}

export function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function statusLabel(value: string) {
  const labels: Record<string, string> = {
    EVIDENCE_PENDING: "Evidence pending",
    UNDER_REVIEW: "Under review",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    INVALIDATED: "Invalidated",
    PASS: "Pass",
    FAILED: "Failed",
    FAIL: "Fail",
    INCONCLUSIVE: "Inconclusive",
    NOT_RUN: "Not run",
    LIMITATIONS_IDENTIFIED: "Limitations identified",
    CHALLENGED: "Challenged",
    INTACT: "Intact",
    COLLAPSED: "Collapsed",
    NOT_AVAILABLE: "Not available",
    PENDING: "Pending",
    MONITORING: "Monitoring",
    READY: "Ready",
    ATTENTION: "Attention",
  };

  return labels[value] || titleCase(value);
}

export function statusTone(value: string) {
  const normalized = value.toUpperCase();

  if (["APPROVED", "PASS", "INTACT", "READY"].includes(normalized)) {
    return "success";
  }

  if (["INVALIDATED", "FAILED", "FAIL", "COLLAPSED", "CHALLENGED"].includes(normalized)) {
    return "danger";
  }

  if (["UNDER_REVIEW", "LIMITATIONS_IDENTIFIED", "PENDING", "ATTENTION", "MONITORING"].includes(normalized)) {
    return "warning";
  }

  if (["EVIDENCE_PENDING", "NOT_RUN", "NOT_AVAILABLE"].includes(normalized)) {
    return "neutral";
  }

  return "info";
}

export function severityTone(value: string) {
  const normalized = value.toUpperCase();

  if (normalized === "CRITICAL") return "danger";
  if (normalized === "WARNING") return "warning";
  return "info";
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
