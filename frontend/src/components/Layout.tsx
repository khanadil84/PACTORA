import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  Bot,
  ChevronRight,
  CircleDot,
  FileCheck2,
  FolderLock,
  History,
  LayoutDashboard,
  Menu,
  Network,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Swords,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useData } from "../context/DataContext";
import { cx, relativeTime, statusLabel } from "../lib/format";
import { StatusBadge } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Command",
    items: [
      { to: "/", label: "Executive Overview", icon: LayoutDashboard, end: true },
      { to: "/commitments", label: "Commitment Center", icon: FileCheck2 },
      { to: "/graph", label: "Trust Graph", icon: Network },
      { to: "/demo", label: "Guided Demonstration", icon: PlayCircle },
    ],
  },
  {
    label: "Assurance",
    items: [
      { to: "/evidence", label: "Evidence Vault", icon: FolderLock },
      { to: "/verification", label: "Verification Center", icon: ShieldCheck },
      { to: "/adversarial", label: "Adversarial Intelligence", icon: Swords },
      { to: "/approvals", label: "Human Approvals", icon: UserCheck },
      { to: "/passport", label: "Trust Passport", icon: BadgeCheck },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/agents", label: "AI Agent Command", icon: Bot },
      { to: "/audit", label: "Audit Timeline", icon: History },
    ],
  },
];

const ALL_NAV = NAV_GROUPS.flatMap((group) => group.items);

function pageInfo(pathname: string) {
  if (pathname.startsWith("/commitments/")) {
    return { label: "Commitment Detail", nav: ALL_NAV[1] };
  }

  const exact = ALL_NAV.find((item) => item.to === pathname);

  if (exact) return { label: exact.label, nav: exact };

  if (pathname.startsWith("/passport/")) {
    return { label: "Trust Passport", nav: ALL_NAV.find((item) => item.to === "/passport") };
  }

  return { label: "PACTORA", nav: undefined };
}

function BrandMark() {
  return (
    <svg viewBox="0 0 40 40" width="30" height="30" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <path
        d="M20 3.5 34 11.2v17.6L20 36.5 6 28.8V11.2Z"
        fill="none"
        stroke="url(#brand-gradient)"
        strokeWidth="1.6"
      />
      <path
        d="M13.2 23.7c0-2.4 1.9-4.3 4.3-4.3 2.3 0 4.1 1.8 4.1 4.1 0 2.1 1.7 3.8 3.8 3.8 2.4 0 4.3-1.9 4.3-4.3s-1.9-4.3-4.3-4.3c-2.1 0-3.8-1.7-3.8-3.8 0-2.3-1.8-4.1-4.1-4.1-2.4 0-4.3 1.9-4.3 4.3"
        fill="none"
        stroke="url(#brand-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Layout() {
  const { health, commitments, refresh, refreshing, lastUpdated } = useData();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const info = pageInfo(location.pathname);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="app-shell">
      <aside className={cx("sidebar", mobileOpen && "sidebar-open")}>
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <div className="brand-name">
              PACTORA <span>∞</span>
            </div>
            <div className="brand-tagline">Proof over promises</div>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <div className="sidebar-environment">
          <span className="environment-dot" />
          <span>Production assurance</span>
          <span className="environment-chip">LOCAL</span>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cx("nav-link", isActive && "nav-link-active")
                  }
                >
                  <item.icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-card">
            <div className={cx("connection-orb", `connection-${health.status}`)} />
            <div className="connection-copy">
              <strong>
                {health.status === "online"
                  ? "Backend connected"
                  : health.status === "offline"
                    ? "Backend offline"
                    : "Connecting…"}
              </strong>
              <span>
                {health.status === "online"
                  ? `${health.latencyMs ?? "—"} ms · API v0.1.0`
                  : "Checking PACTORA Core"}
              </span>
            </div>
            <CircleDot size={14} className="connection-icon" />
          </div>
          <div className="sidebar-meta">
            <span>{commitments.length} commitments</span>
            <span>{lastUpdated ? `Synced ${relativeTime(lastUpdated)}` : "Not synced"}</span>
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />
      ) : null}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={19} />
            </button>
            <div className="breadcrumb">
              <span>PACTORA</span>
              <ChevronRight size={13} />
              <strong>{info.label}</strong>
            </div>
          </div>

          <div className="topbar-right">
            <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
              <Search size={15} />
              <span>Search commitments, evidence, pages</span>
              <kbd>Ctrl K</kbd>
            </button>

            <div className={cx("live-pill", `live-${health.status}`)}>
              <span className="live-dot" />
              <span>
                {health.status === "online"
                  ? "Live"
                  : health.status === "offline"
                    ? "Offline"
                    : "Syncing"}
              </span>
            </div>

            <button
              className="icon-button refresh-button"
              onClick={() => void refresh()}
              aria-label="Refresh live data"
            >
              <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
            </button>

            <div className="user-chip">
              <span className="avatar">SE</span>
              <span className="user-copy">
                <strong>Security Engineering</strong>
                <span>Administrator</span>
              </span>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commitments={commitments.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
        }))}
        onNavigate={(path) => {
          setPaletteOpen(false);
          navigate(path);
        }}
      />
    </div>
  );
}

function CommandPalette({
  open,
  onClose,
  commitments,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  commitments: Array<{ id: string; title: string; status: string }>;
  onNavigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    const pages = ALL_NAV.filter((item) =>
      item.label.toLowerCase().includes(normalized),
    ).slice(0, 5);

    const commitmentsMatched = commitments
      .filter(
        (item) =>
          item.title.toLowerCase().includes(normalized) ||
          item.id.toLowerCase().includes(normalized),
      )
      .slice(0, 6);

    return { pages, commitmentsMatched };
  }, [commitments, query]);

  if (!open) return null;

  return (
    <div className="palette-layer" onMouseDown={onClose} role="presentation">
      <div className="palette" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label="Search">
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages and commitments…"
            aria-label="Search"
          />
          <kbd>ESC</kbd>
        </div>

        {results.pages.length === 0 && results.commitmentsMatched.length === 0 ? (
          <p className="palette-empty">No matches. Try a commitment title or ID.</p>
        ) : (
          <div className="palette-results">
            {results.pages.length > 0 ? (
              <div className="palette-group">
                <p>Navigate</p>
                {results.pages.map((page) => (
                  <button key={page.to} className="palette-item" onClick={() => onNavigate(page.to)}>
                    <page.icon size={15} />
                    <span>{page.label}</span>
                    <ChevronRight size={13} />
                  </button>
                ))}
              </div>
            ) : null}

            {results.commitmentsMatched.length > 0 ? (
              <div className="palette-group">
                <p>Commitments</p>
                {results.commitmentsMatched.map((commitment) => (
                  <button
                    key={commitment.id}
                    className="palette-item"
                    onClick={() => onNavigate(`/commitments/${commitment.id}`)}
                  >
                    <FileCheck2 size={15} />
                    <span className="palette-item-copy">
                      <strong>{commitment.title}</strong>
                      <span>{commitment.id}</span>
                    </span>
                    <StatusBadge
                      status={commitment.status}
                      label={statusLabel(commitment.status)}
                      dot={false}
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
