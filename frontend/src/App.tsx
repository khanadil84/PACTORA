import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Adversarial } from "./pages/Adversarial";
import { Agents } from "./pages/Agents";
import { Approvals } from "./pages/Approvals";
import { Audit } from "./pages/Audit";
import { CommitmentDetail } from "./pages/CommitmentDetail";
import { Commitments } from "./pages/Commitments";
import { Demo } from "./pages/Demo";
import { EvidenceVault } from "./pages/EvidenceVault";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { Passport } from "./pages/Passport";
import { TrustGraphPage } from "./pages/TrustGraphPage";
import { Verification } from "./pages/Verification";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="commitments" element={<Commitments />} />
        <Route path="commitments/:id" element={<CommitmentDetail />} />
        <Route path="evidence" element={<EvidenceVault />} />
        <Route path="agents" element={<Agents />} />
        <Route path="verification" element={<Verification />} />
        <Route path="adversarial" element={<Adversarial />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="passport" element={<Passport />} />
        <Route path="passport/:id" element={<Passport />} />
        <Route path="audit" element={<Audit />} />
        <Route path="graph" element={<TrustGraphPage />} />
        <Route path="demo" element={<Demo />} />
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
