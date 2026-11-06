import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "../api";
import type {
  AuditEvent,
  Commitment,
  CommitmentDetail,
  HealthState,
  ReviewsResponse,
  TrustPassport,
} from "../types";

interface DataContextValue {
  health: HealthState;
  commitments: Commitment[];
  details: Record<string, CommitmentDetail>;
  passports: Record<string, TrustPassport>;
  reviews: Record<string, ReviewsResponse>;
  audits: Record<string, AuditEvent[]>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: string | null;
  refresh: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

const INITIAL_HEALTH: HealthState = {
  status: "checking",
  latencyMs: null,
  timestamp: null,
  lastCheckedAt: null,
};

export function DataProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<HealthState>(INITIAL_HEALTH);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [details, setDetails] = useState<Record<string, CommitmentDetail>>({});
  const [passports, setPassports] = useState<Record<string, TrustPassport>>({});
  const [reviews, setReviews] = useState<Record<string, ReviewsResponse>>({});
  const [audits, setAudits] = useState<Record<string, AuditEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checkHealth = useCallback(async () => {
    const started = performance.now();

    try {
      const result = await api.health();
      const latency = Math.round(performance.now() - started);

      if (!mounted.current) return;

      setHealth({
        status: "online",
        latencyMs: latency,
        timestamp: result.timestamp,
        lastCheckedAt: new Date().toISOString(),
      });
    } catch {
      if (!mounted.current) return;

      setHealth((current) => ({
        status: "offline",
        latencyMs: null,
        timestamp: current.timestamp,
        lastCheckedAt: new Date().toISOString(),
      }));
    }
  }, []);

  const load = useCallback(async (initial: boolean) => {
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const commitmentList = await api.listCommitments();

      if (!mounted.current) return;

      setCommitments(commitmentList);
      setError(null);

      const bundles = await Promise.all(
        commitmentList.map(async (commitment) => {
          const [detail, passport, reviewSet, audit] = await Promise.allSettled([
            api.getCommitment(commitment.id),
            api.trustPassport(commitment.id),
            api.reviews(commitment.id),
            api.getAudit(commitment.id),
          ]);

          return {
            id: commitment.id,
            detail: detail.status === "fulfilled" ? detail.value : null,
            passport: passport.status === "fulfilled" ? passport.value : null,
            reviews: reviewSet.status === "fulfilled" ? reviewSet.value : null,
            audit: audit.status === "fulfilled" ? audit.value : null,
          };
        }),
      );

      if (!mounted.current) return;

      const nextDetails: Record<string, CommitmentDetail> = {};
      const nextPassports: Record<string, TrustPassport> = {};
      const nextReviews: Record<string, ReviewsResponse> = {};
      const nextAudits: Record<string, AuditEvent[]> = {};

      for (const bundle of bundles) {
        if (bundle.detail) nextDetails[bundle.id] = bundle.detail;
        if (bundle.passport) nextPassports[bundle.id] = bundle.passport;
        if (bundle.reviews) nextReviews[bundle.id] = bundle.reviews;
        if (bundle.audit) nextAudits[bundle.id] = bundle.audit;
      }

      setDetails(nextDetails);
      setPassports(nextPassports);
      setReviews(nextReviews);
      setAudits(nextAudits);
      setLastUpdated(new Date().toISOString());
    } catch (caught) {
      if (!mounted.current) return;

      const message =
        caught instanceof ApiError
          ? caught.message
          : "Unable to load the PACTORA portfolio.";

      setError(message);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    void checkHealth();
    const timer = window.setInterval(() => {
      void checkHealth();
    }, 15000);

    return () => window.clearInterval(timer);
  }, [checkHealth]);

  const refresh = useCallback(async () => {
    await load(false);
    await checkHealth();
  }, [checkHealth, load]);

  const value = useMemo<DataContextValue>(
    () => ({
      health,
      commitments,
      details,
      passports,
      reviews,
      audits,
      loading,
      refreshing,
      error,
      lastUpdated,
      refresh,
    }),
    [
      health,
      commitments,
      details,
      passports,
      reviews,
      audits,
      loading,
      refreshing,
      error,
      lastUpdated,
      refresh,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const context = useContext(DataContext);

  if (!context) {
    throw new Error("useData must be used within DataProvider");
  }

  return context;
}
