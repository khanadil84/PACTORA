"""Verify all seven Guided Demonstration stages in isolated demo state.

The script fingerprints the real database and evidence directory before the
run, executes the complete workflow against a temporary SQLite database and
evidence directory, and then proves the real files are byte-for-byte unchanged.

Run from the repository root:

    python -m backend.demo.verify_guided_demo
    python -m backend.demo.verify_guided_demo --keep
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.demo import isolation  # noqa: E402

API_KEY = "pactora-isolation-verify-key"
APPROVER_ID = "security.manager"
APPROVAL_TOKEN = "pactora-isolation-verify-token"

SCENARIO = {
    "title": "Customer Data Encryption",
    "claim": "Customer data is encrypted at rest.",
    "owner": "Security Engineering",
    "acceptance_criteria": (
        "Approved storage configuration demonstrates encryption enabled."
    ),
}

EVIDENCE = (
    "environment=demo\n"
    "storage_encryption=true\n"
    "algorithm=AES-256\n"
    "scope=customer-data"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the seven-stage Guided Demonstration in isolation."
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="Optional explicit isolated state directory.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset an explicit state directory before verifying.",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="Keep the temporary isolated state after verification.",
    )
    return parser.parse_args()


def stage(number: str, title: str) -> None:
    print(f"[{number}/7] {title}")


def expect(response, status: int, label: str) -> dict:
    if response.status_code != status:
        raise AssertionError(
            f"{label} failed: HTTP {response.status_code}: {response.text}"
        )
    return response.json()


def main() -> int:
    args = parse_args()

    if args.state_dir is not None:
        state_dir = args.state_dir
        auto_created = False
    else:
        state_dir = Path(
            tempfile.mkdtemp(prefix="pactora-guided-demo-verify-")
        )
        auto_created = True

    before = isolation.snapshot_production()
    print("Original state fingerprint:")
    print(f"  database: {before['db_path']} ({before['db_sha256']})")
    print(f"  evidence: {len(before['evidence'])} files")
    print()

    paths = isolation.prepare_state(state_dir, reset=args.reset)

    os.environ["PACTORA_API_KEY"] = API_KEY
    os.environ["PACTORA_PRINCIPAL_ID"] = "isolation.verify"
    os.environ["PACTORA_PRINCIPAL_ROLE"] = "admin"
    os.environ["PACTORA_PRINCIPAL_NAME"] = "Isolation Verify"
    os.environ["PACTORA_APPROVER_ID"] = APPROVER_ID
    os.environ["PACTORA_APPROVAL_TOKEN"] = APPROVAL_TOKEN
    os.environ["PACTORA_DEMO_MODE"] = "1"
    os.environ.pop("PACTORA_API_KEYS", None)

    from fastapi.testclient import TestClient

    from backend.app import main as app_main

    isolation.install_isolated_paths(app_main, paths)
    isolation.assert_bound(app_main, paths)

    print("Isolated state:")
    print(f"  database: {paths.db_path}")
    print(f"  evidence: {paths.evidence_dir}")
    print()

    with TestClient(app_main.app) as client:
        client.headers.update({"X-API-Key": API_KEY})

        stage("01", "Create the commitment")
        created = expect(
            client.post("/commitments", json=SCENARIO),
            200,
            "create commitment",
        )
        commitment_id = created["commitment_id"]
        detail = expect(
            client.get(f"/commitments/{commitment_id}"),
            200,
            "read commitment",
        )
        assert detail["commitment"]["status"] == "EVIDENCE_PENDING"
        print(f"  {commitment_id} created")

        stage("02", "Attach evidence")
        evidence_result = expect(
            client.post(
                f"/commitments/{commitment_id}/evidence",
                json={"filename": "encryption-config.txt", "content": EVIDENCE},
            ),
            200,
            "attach evidence",
        )
        evidence_id = evidence_result["evidence_id"]
        detail = expect(
            client.get(f"/commitments/{commitment_id}"),
            200,
            "read evidence",
        )
        stored_path = Path(detail["evidence"][0]["stored_path"]).resolve()
        assert stored_path.parent == paths.evidence_dir.resolve()
        assert stored_path.read_bytes() == EVIDENCE.encode("utf-8")
        print(f"  {evidence_id} stored in {stored_path}")

        stage("03", "Verify integrity, proof and independent review")
        integrity = expect(
            client.post(f"/commitments/{commitment_id}/verify"),
            200,
            "verify integrity",
        )
        assert integrity["evidence_integrity"] == "PASS"

        checks = expect(
            client.post(
                f"/commitments/{commitment_id}/proof-checks",
                json={
                    "checks": [
                        {
                            "evidence_id": evidence_id,
                            "name": "Encryption enabled",
                            "operator": "contains",
                            "expected_value": "storage_encryption=true",
                        }
                    ]
                },
            ),
            200,
            "create proof check",
        )
        assert checks["checks_created"] == 1

        proof = expect(
            client.post(f"/commitments/{commitment_id}/evaluate"),
            200,
            "evaluate proof",
        )
        assert proof["result"] == "PASS"

        independent = expect(
            client.post(f"/commitments/{commitment_id}/independent-review"),
            200,
            "independent review",
        )
        assert independent["result"] == "PASS"
        print("  integrity PASS, proof PASS, independent PASS")

        stage("04", "Run ADVERSARY review")
        adversarial = expect(
            client.post(f"/commitments/{commitment_id}/adversarial-review"),
            200,
            "adversarial review",
        )
        assert adversarial["result"]
        assert isinstance(adversarial["findings"], list)
        print(
            f"  {adversarial['review_id']} -> {adversarial['result']} "
            f"with {len(adversarial['findings'])} findings"
        )

        stage("05", "Record human approval")
        approval = expect(
            client.post(
                f"/commitments/{commitment_id}/approval",
                headers={"X-Approval-Token": APPROVAL_TOKEN},
                json={
                    "approver_id": APPROVER_ID,
                    "decision": "APPROVE",
                    "reason": "Isolated demonstration: all gates passed.",
                },
            ),
            200,
            "approve commitment",
        )
        assert approval["status"] == "APPROVED"
        print(f"  {approval['approval_id']} recorded")

        stage("06", "Break trust and run SENTINEL")
        tamper = expect(
            client.post(f"/demo/commitments/{commitment_id}/tamper"),
            200,
            "demo tamper",
        )
        assert tamper["before_sha256"] != tamper["after_sha256"]
        tampered_bytes = stored_path.read_bytes()
        assert tampered_bytes.startswith(EVIDENCE.encode("utf-8"))
        assert b"[PACTORA DEMO EXERCISE]" in tampered_bytes
        assert hashlib.sha256(tampered_bytes).hexdigest() == (
            tamper["after_sha256"]
        )
        print("  evidence modified only inside the isolated evidence directory")

        scan = expect(
            client.post(f"/commitments/{commitment_id}/trust-scan"),
            200,
            "SENTINEL trust scan",
        )
        assert scan["trust_status"] == "COLLAPSED"
        assert scan["commitment_status"] == "INVALIDATED"
        assert scan["failed_evidence_count"] >= 1
        print(
            f"  SENTINEL {scan['trust_status']}; "
            f"{scan['failed_evidence_count']} failed evidence record(s)"
        )

        stage("07", "Inspect the collapsed passport and blocked re-attestation")
        blocked = client.post(
            f"/commitments/{commitment_id}/evidence",
            json={"filename": "late-evidence.txt", "content": "late=true"},
        )
        assert blocked.status_code == 409, blocked.text
        assert "locked" in blocked.text.lower()

        passport = expect(
            client.get(f"/commitments/{commitment_id}/trust-passport"),
            200,
            "trust passport",
        )
        assert passport["passport_id"].startswith("PAS-")
        assert passport["claim_semantically_verified"] is False
        assert passport["trust_summary"]["evidence_integrity"] == "COLLAPSED"
        assert passport["trust_summary"]["human_approval_state"] == "APPROVE"
        assert passport["proof"]["latest_result"] == "PASS"
        assert passport["verification"]["latest_result"] == "PASS"
        assert passport["adversarial"]["latest_result"]
        event_types = {
            item["event_type"] for item in passport["audit_trail"]
        }
        assert "DEMO_EVIDENCE_TAMPERED" in event_types
        assert "TRUST_COLLAPSE_DETECTED" in event_types
        print("  passport collapsed, approval preserved, new evidence blocked")

    assert paths.db_path.is_file()
    assert any(paths.evidence_dir.iterdir())
    isolation.assert_production_unchanged(before)

    print()
    print("PASS: seven stages completed exclusively in isolated state.")
    print("PASS: original database and evidence directory are unchanged.")
    print(f"Verified isolated database: {paths.db_path}")
    print(f"Verified isolated evidence: {paths.evidence_dir}")

    if auto_created and not args.keep:
        gc.collect()
        for attempt in range(5):
            try:
                shutil.rmtree(state_dir)
                print("Temporary isolated state removed.")
                break
            except PermissionError:
                if attempt == 4:
                    print(
                        "Temporary isolated state left in place because a "
                        f"SQLite handle is still open: {state_dir}"
                    )
                else:
                    time.sleep(0.2)
    else:
        print(f"Isolated state kept at: {state_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
