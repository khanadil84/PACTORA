import hashlib
import json

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from backend.app import main


MULTI_API_KEYS = {
    "test-admin-key": {
        "id": "test-admin",
        "role": "admin",
        "name": "Test Admin",
    },
    "test-owner-a-key": {
        "id": "owner-a",
        "role": "owner",
        "name": "Owner A",
    },
    "test-owner-b-key": {
        "id": "owner-b",
        "role": "owner",
        "name": "Owner B",
    },
    "test-reviewer-key": {
        "id": "reviewer",
        "role": "reviewer",
        "name": "Reviewer",
    },
    "test-approver-key": {
        "id": "security.manager",
        "role": "approver",
        "name": "Security Manager",
    },
    "test-service-key": {
        "id": "trust-service",
        "role": "service",
        "name": "Trust Service",
    },
}

ROLE_KEYS = {
    "admin": "test-admin-key",
    "owner-a": "test-owner-a-key",
    "owner-b": "test-owner-b-key",
    "reviewer": "test-reviewer-key",
    "approver": "test-approver-key",
    "service": "test-service-key",
}


def auth_headers(role, **extra):
    headers = {"X-API-Key": ROLE_KEYS[role]}
    headers.update(extra)
    return headers


@pytest.fixture
def client(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    evidence_dir = tmp_path / "evidence"

    data_dir.mkdir()
    evidence_dir.mkdir()

    monkeypatch.setattr(main, "DATA_DIR", data_dir)
    monkeypatch.setattr(main, "EVIDENCE_DIR", evidence_dir)
    monkeypatch.setattr(main, "DB_PATH", data_dir / "test.db")
    monkeypatch.setenv("PACTORA_API_KEY", "test-api-key")
    monkeypatch.setenv("PACTORA_PRINCIPAL_ID", "test-owner")
    monkeypatch.setenv("PACTORA_PRINCIPAL_ROLE", "admin")

    with TestClient(main.app) as test_client:
        test_client.headers.update({"X-API-Key": "test-api-key"})
        yield test_client


@pytest.fixture
def multi_client(client, monkeypatch):
    monkeypatch.setenv("PACTORA_API_KEYS", json.dumps(MULTI_API_KEYS))
    client.headers.update({"X-API-Key": "test-admin-key"})
    return client


def create_commitment(client):
    response = client.post(
        "/commitments",
        json={
            "title": "Customer Data Encryption",
            "claim": "Customer data is encrypted at rest.",
            "owner": "Security Engineering",
            "acceptance_criteria": (
                "Approved storage configuration demonstrates encryption enabled."
            ),
        },
    )

    assert response.status_code == 200
    return response.json()["commitment_id"]


def attach_evidence(client, commitment_id):
    response = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={
            "filename": "encryption-config.txt",
            "content": "storage_encryption=true\nalgorithm=AES-256",
        },
    )

    assert response.status_code == 200
    return response.json()


def test_health_endpoint(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_commitment_creation(client):
    commitment_id = create_commitment(client)

    response = client.get(f"/commitments/{commitment_id}")

    assert response.status_code == 200
    assert response.json()["commitment"]["status"] == "EVIDENCE_PENDING"


def test_evidence_attachment_and_fingerprint(client):
    commitment_id = create_commitment(client)

    result = attach_evidence(client, commitment_id)

    assert result["status"] == "UNDER_REVIEW"
    assert len(result["sha256"]) == 64

    details = client.get(
        f"/commitments/{commitment_id}"
    ).json()

    evidence = details["evidence"][0]

    assert evidence["sha256"] == result["sha256"]


def test_evidence_integrity_passes(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.post(
        f"/commitments/{commitment_id}/verify"
    )

    assert response.status_code == 200

    result = response.json()

    assert result["evidence_integrity"] == "PASS"
    assert result["commitment_status"] == "UNDER_REVIEW"
    assert result["claim_semantically_verified"] is False


def test_tampered_evidence_is_invalidated(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    details = client.get(
        f"/commitments/{commitment_id}"
    ).json()

    evidence_path = details["evidence"][0]["stored_path"]

    with open(evidence_path, "ab") as file:
        file.write(b"\ntampered=true")

    response = client.post(
        f"/commitments/{commitment_id}/verify"
    )

    result = response.json()

    assert response.status_code == 200
    assert result["evidence_integrity"] == "FAILED"
    assert result["commitment_status"] == "INVALIDATED"


def test_missing_evidence_is_rejected(client):
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/verify"
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "No evidence attached."


def test_unknown_commitment_is_not_found(client):
    response = client.get("/commitments/PACT-UNKNOWN")

    assert response.status_code == 404


def test_audit_history_records_events(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/verify"
    )

    response = client.get(
        f"/commitments/{commitment_id}/audit"
    )

    assert response.status_code == 200

    event_types = [
        event["event_type"]
        for event in response.json()
    ]

    assert "COMMITMENT_CREATED" in event_types
    assert "EVIDENCE_ATTACHED" in event_types
    assert "EVIDENCE_INTEGRITY_CHECK" in event_types


def test_proof_engine_passes_explicit_check(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    response = client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={
            "checks": [{
                "evidence_id": evidence["evidence_id"],
                "name": "Encryption setting exists",
                "operator": "contains",
                "expected_value": "storage_encryption=true"
            }]
        }
    )

    assert response.status_code == 200
    assert response.json()["checks_created"] == 1

    evaluation = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )

    assert evaluation.status_code == 200
    assert evaluation.json()["result"] == "PASS"
    assert evaluation.json()["claim_semantically_verified"] is False


def test_proof_engine_detects_failed_check(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={
            "checks": [{
                "evidence_id": evidence["evidence_id"],
                "name": "Encryption disabled check",
                "operator": "contains",
                "expected_value": "storage_encryption=false"
            }]
        }
    )

    evaluation = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )

    assert evaluation.status_code == 200
    assert evaluation.json()["result"] == "FAIL"


def test_proof_history_is_persisted(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={
            "checks": [{
                "evidence_id": evidence["evidence_id"],
                "name": "Encryption setting exists",
                "operator": "contains",
                "expected_value": "storage_encryption=true"
            }]
        }
    )

    client.post(f"/commitments/{commitment_id}/evaluate")

    history = client.get(
        f"/commitments/{commitment_id}/proof-history"
    )

    assert history.status_code == 200
    assert len(history.json()) == 1
    assert history.json()[0]["result"] == "PASS"


def test_independent_verifier_rechecks_evidence(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={
            "checks": [{
                "evidence_id": evidence["evidence_id"],
                "name": "Encryption setting",
                "operator": "contains",
                "expected_value": "storage_encryption=true"
            }]
        }
    )

    response = client.post(
        f"/commitments/{commitment_id}/independent-review"
    )

    assert response.status_code == 200
    assert response.json()["result"] == "PASS"
    assert response.json()["claim_semantically_verified"] is False


def test_adversarial_review_identifies_weak_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.post(
        f"/commitments/{commitment_id}/adversarial-review"
    )

    assert response.status_code == 200
    assert response.json()["result"] == "CHALLENGED"

    codes = [
        finding["code"]
        for finding in response.json()["findings"]
    ]

    assert "SINGLE_EVIDENCE_SOURCE" in codes
    assert "NO_ACCEPTANCE_CHECKS" in codes
    assert "SEMANTIC_TRUTH_NOT_ESTABLISHED" in codes


def test_review_history_is_persisted(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/adversarial-review"
    )

    response = client.get(
        f"/commitments/{commitment_id}/reviews"
    )

    assert response.status_code == 200
    assert len(response.json()["adversarial_reviews"]) == 1


# PACTORA HUMAN APPROVAL ENGINE TESTS

def configure_approver(monkeypatch):
    monkeypatch.setenv("PACTORA_APPROVER_ID", "security.manager")
    monkeypatch.setenv("PACTORA_APPROVAL_TOKEN", "test-approval-token")


def approval_headers():
    return {"X-Approval-Token": "test-approval-token"}


def prepare_approval_gates(client, commitment_id):
    evidence = attach_evidence(client, commitment_id)

    checks_response = client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={
            "checks": [
                {
                    "evidence_id": evidence["evidence_id"],
                    "name": "Encryption setting",
                    "operator": "contains",
                    "expected_value": "storage_encryption=true",
                }
            ]
        },
    )
    assert checks_response.status_code == 200

    evaluation = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )
    assert evaluation.status_code == 200
    assert evaluation.json()["result"] == "PASS"

    verification = client.post(
        f"/commitments/{commitment_id}/independent-review"
    )
    assert verification.status_code == 200
    assert verification.json()["result"] == "PASS"

    adversarial = client.post(
        f"/commitments/{commitment_id}/adversarial-review"
    )
    assert adversarial.status_code == 200
    assert adversarial.json()["result"] == "LIMITATIONS_IDENTIFIED"


def test_approval_rejects_unauthorized_approver(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers={"X-Approval-Token": "wrong-token"},
        json={
            "approver_id": "intruder",
            "decision": "APPROVE",
            "reason": "Unauthorized approval attempt",
        },
    )

    assert response.status_code == 403


def test_approval_is_blocked_when_gates_have_not_passed(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "Attempt approval without completed verification",
        },
    )

    assert response.status_code == 409


def test_authorized_rejection_is_recorded(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "REJECT",
            "reason": "Evidence is insufficient for acceptance",
        },
    )

    assert response.status_code == 200
    assert "REJECTED" in str(
        client.get(f"/commitments/{commitment_id}").json()
    )


def test_approval_succeeds_after_all_gates_pass(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    prepare_approval_gates(client, commitment_id)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "All configured verification gates passed",
        },
    )

    assert response.status_code == 200
    assert "APPROVED" in str(
        client.get(f"/commitments/{commitment_id}").json()
    )


def test_approval_history_and_audit_are_persisted(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "REJECT",
            "reason": "Test persistence of approval history",
        },
    )
    assert response.status_code == 200

    history = client.get(
        f"/commitments/{commitment_id}/approval-history"
    )
    assert history.status_code == 200
    assert "REJECT" in str(history.json())

    audit = client.get(
        f"/commitments/{commitment_id}/audit"
    )
    assert audit.status_code == 200
    assert "HUMAN_APPROVAL_DECISION" in str(audit.json())


def get_evidence_path(commitment_id):
    with main.connect() as db:
        row = db.execute(
            "SELECT stored_path FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchone()

    assert row is not None
    return main.Path(row["stored_path"])


def test_trust_scan_passes_for_unchanged_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.post(
        f"/commitments/{commitment_id}/trust-scan"
    )

    assert response.status_code == 200
    assert response.json()["trust_status"] == "INTACT"
    assert response.json()["failed_evidence_count"] == 0


def test_trust_scan_invalidates_modified_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.write_text(
        "storage_encryption=false",
        encoding="utf-8"
    )

    response = client.post(
        f"/commitments/{commitment_id}/trust-scan"
    )

    assert response.status_code == 200
    assert response.json()["trust_status"] == "COLLAPSED"
    assert response.json()["commitment_status"] == "INVALIDATED"

    audit = client.get(
        f"/commitments/{commitment_id}/audit"
    )

    assert audit.status_code == 200
    assert "TRUST_COLLAPSE_DETECTED" in str(audit.json())


def test_trust_scan_invalidates_missing_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.unlink()

    response = client.post(
        f"/commitments/{commitment_id}/trust-scan"
    )

    assert response.status_code == 200
    assert response.json()["trust_status"] == "COLLAPSED"
    assert response.json()["commitment_status"] == "INVALIDATED"
    assert response.json()["failed_evidence_count"] == 1


def test_approval_blocks_when_evidence_changes_after_reviews(
    client, monkeypatch
):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)

    prepare_approval_gates(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.write_text(
        "storage_encryption=false",
        encoding="utf-8"
    )

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "Attempt approval after evidence modification",
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["trust_status"] == "COLLAPSED"

    commitment = client.get(
        f"/commitments/{commitment_id}"
    )

    assert "INVALIDATED" in str(commitment.json())



# ============================================================
# TRUST PASSPORT TESTS
# ============================================================

def test_trust_passport_returns_404_for_unknown_commitment(client):
    response = client.get(
        "/commitments/PACT-UNKNOWN/trust-passport"
    )

    assert response.status_code == 404


def test_trust_passport_returns_complete_structure(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.get(
        f"/commitments/{commitment_id}/trust-passport"
    )

    assert response.status_code == 200

    passport = response.json()

    assert passport["passport_id"].startswith("PAS-")
    assert passport["commitment"]["id"] == commitment_id
    assert "evidence" in passport
    assert "proof" in passport
    assert "verification" in passport
    assert "adversarial" in passport
    assert "approval" in passport
    assert "audit_trail" in passport
    assert "trust_summary" in passport

    assert passport["claim_semantically_verified"] is False
    assert passport["trust_summary"]["claim_semantically_verified"] is False


def test_trust_passport_reports_intact_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.get(
        f"/commitments/{commitment_id}/trust-passport"
    )

    passport = response.json()

    assert response.status_code == 200
    assert passport["trust_summary"]["evidence_integrity"] == "INTACT"
    assert passport["evidence"][0]["integrity"] == "PASS"
    assert passport["evidence"][0]["file_exists"] is True


def test_trust_passport_reports_modified_evidence_without_mutating_status(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.write_text(
        "modified_evidence=true",
        encoding="utf-8"
    )

    before = client.get(
        f"/commitments/{commitment_id}"
    ).json()["commitment"]["status"]

    response = client.get(
        f"/commitments/{commitment_id}/trust-passport"
    )

    after = client.get(
        f"/commitments/{commitment_id}"
    ).json()["commitment"]["status"]

    passport = response.json()

    assert response.status_code == 200
    assert passport["trust_summary"]["evidence_integrity"] == "COLLAPSED"
    assert passport["evidence"][0]["integrity"] == "FAILED"
    assert before == after


def test_trust_passport_reports_missing_evidence(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.unlink()

    response = client.get(
        f"/commitments/{commitment_id}/trust-passport"
    )

    passport = response.json()

    assert response.status_code == 200
    assert passport["trust_summary"]["evidence_integrity"] == "COLLAPSED"
    assert passport["evidence"][0]["file_exists"] is False
    assert passport["evidence"][0]["integrity"] == "FAILED"


def test_trust_passport_reports_unrun_reviews_and_approval(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    response = client.get(
        f"/commitments/{commitment_id}/trust-passport"
    )

    passport = response.json()

    assert response.status_code == 200
    assert passport["proof"]["latest_result"] is None
    assert passport["verification"]["latest_result"] is None
    assert passport["adversarial"]["latest_result"] is None
    assert passport["approval"]["latest_decision"] is None

    assert passport["trust_summary"]["proof_state"] == "NOT_RUN"
    assert passport["trust_summary"]["human_approval_state"] == "PENDING"


def test_dependency_creation_and_duplicate_prevention(client):
    prerequisite = create_commitment(client)
    dependent = create_commitment(client)

    response = client.post(
        f"/commitments/{dependent}/dependencies",
        json={"depends_on_id": prerequisite},
    )

    assert response.status_code == 200
    assert response.json()["relationship"] == "DEPENDS_ON"

    duplicate = client.post(
        f"/commitments/{dependent}/dependencies",
        json={"depends_on_id": prerequisite},
    )

    assert duplicate.status_code == 409


def test_dependency_rejects_self_reference(client):
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/dependencies",
        json={"depends_on_id": commitment_id},
    )

    assert response.status_code == 400


def test_dependency_rejects_circular_relationship(client):
    first = create_commitment(client)
    second = create_commitment(client)

    assert client.post(
        f"/commitments/{first}/dependencies",
        json={"depends_on_id": second},
    ).status_code == 200

    response = client.post(
        f"/commitments/{second}/dependencies",
        json={"depends_on_id": first},
    )

    assert response.status_code == 409


def test_dependency_rejects_missing_commitment(client):
    commitment_id = create_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/dependencies",
        json={"depends_on_id": "PACT-NOT-FOUND"},
    )

    assert response.status_code == 404


def test_trust_graph_returns_dependency_relationship(client):
    prerequisite = create_commitment(client)
    dependent = create_commitment(client)

    client.post(
        f"/commitments/{dependent}/dependencies",
        json={"depends_on_id": prerequisite},
    )

    response = client.get(
        f"/commitments/{dependent}/trust-graph"
    )

    assert response.status_code == 200

    graph = response.json()

    assert any(
        edge["type"] == "DEPENDS_ON"
        and edge["source"] == dependent
        and edge["target"] == prerequisite
        for edge in graph["edges"]
    )


def test_trust_collapse_propagates_to_transitive_dependents(client):
    root = create_commitment(client)
    second = create_commitment(client)
    third = create_commitment(client)

    attach_evidence(client, root)

    client.post(
        f"/commitments/{second}/dependencies",
        json={"depends_on_id": root},
    )

    client.post(
        f"/commitments/{third}/dependencies",
        json={"depends_on_id": second},
    )

    details = client.get(
        f"/commitments/{root}"
    ).json()

    evidence_path = details["evidence"][0]["stored_path"]

    with open(evidence_path, "ab") as file:
        file.write(b"\ntampered=true")

    response = client.post(
        f"/commitments/{root}/trust-scan"
    )

    assert response.status_code == 200

    result = response.json()

    assert result["trust_status"] == "COLLAPSED"
    assert set(result["affected_commitments"]) == {
        root, second, third
    }

    for commitment_id in (root, second, third):
        details = client.get(
            f"/commitments/{commitment_id}"
        ).json()

        assert details["commitment"]["status"] == "INVALIDATED"



# ============================================================
# CRITICAL REGRESSION TESTS
# ============================================================

def test_proof_pass_interpretation_is_accurate(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={"checks": [{
            "evidence_id": evidence["evidence_id"],
            "name": "Encryption enabled",
            "operator": "contains",
            "expected_value": "storage_encryption=true"
        }]}
    )

    response = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )

    assert response.status_code == 200
    assert response.json()["result"] == "PASS"
    assert "All configured deterministic checks passed" in response.json()["interpretation"]
    assert response.json()["claim_semantically_verified"] is False


def test_proof_fail_interpretation_is_accurate(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={"checks": [{
            "evidence_id": evidence["evidence_id"],
            "name": "Encryption disabled",
            "operator": "contains",
            "expected_value": "storage_encryption=false"
        }]}
    )

    response = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )

    assert response.status_code == 200
    assert response.json()["result"] == "FAIL"
    assert "checks failed" in response.json()["interpretation"]


def test_proof_inconclusive_interpretation_is_accurate(client):
    commitment_id = create_commitment(client)
    evidence = attach_evidence(client, commitment_id)

    client.post(
        f"/commitments/{commitment_id}/proof-checks",
        json={"checks": [{
            "evidence_id": evidence["evidence_id"],
            "name": "Encryption enabled",
            "operator": "contains",
            "expected_value": "storage_encryption=true"
        }]}
    )

    evidence_path = get_evidence_path(commitment_id)
    evidence_path.write_text(
        "storage_encryption=false",
        encoding="utf-8"
    )

    response = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )

    assert response.status_code == 200
    assert response.json()["result"] == "INCONCLUSIVE"
    assert "inconclusive" in response.json()["interpretation"].lower()


def test_approval_case_variations_cannot_bypass_integrity_check(
    client, monkeypatch
):
    configure_approver(monkeypatch)

    for decision_value in ("approve", "Approve"):
        commitment_id = create_commitment(client)
        prepare_approval_gates(client, commitment_id)

        evidence_path = get_evidence_path(commitment_id)
        evidence_path.write_text(
            "storage_encryption=false",
            encoding="utf-8"
        )

        response = client.post(
            f"/commitments/{commitment_id}/approval",
            headers=approval_headers(),
            json={
                "approver_id": "security.manager",
                "decision": decision_value,
                "reason": "Regression test for normalized approval integrity",
            },
        )

        assert response.status_code == 409, (
            f"{decision_value} bypassed evidence integrity validation"
        )
        assert response.json()["detail"]["trust_status"] == "COLLAPSED"


def test_approval_blocks_when_new_evidence_is_added_after_reviews(
    client, monkeypatch
):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)
    prepare_approval_gates(client, commitment_id)

    new_evidence = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={
            "filename": "backup-config.txt",
            "content": "backup_encryption=true"
        }
    )
    assert new_evidence.status_code == 200

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "Attempt approval using stale reviews"
        }
    )

    assert response.status_code == 409
    gates = response.json()["detail"]["gates"]
    assert gates["proof_snapshot_matches"] is False
    assert gates["verification_snapshot_matches"] is False
    assert gates["adversarial_snapshot_matches"] is False


def test_approval_succeeds_after_reviews_are_refreshed_for_new_evidence(
    client, monkeypatch
):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)
    prepare_approval_gates(client, commitment_id)

    new_evidence = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={
            "filename": "backup-config.txt",
            "content": "backup_encryption=true"
        }
    )
    assert new_evidence.status_code == 200

    evaluation = client.post(
        f"/commitments/{commitment_id}/evaluate"
    )
    assert evaluation.status_code == 200
    assert evaluation.json()["result"] == "PASS"

    verification = client.post(
        f"/commitments/{commitment_id}/independent-review"
    )
    assert verification.status_code == 200
    assert verification.json()["result"] == "PASS"

    adversarial = client.post(
        f"/commitments/{commitment_id}/adversarial-review"
    )
    assert adversarial.status_code == 200
    assert adversarial.json()["result"] == "LIMITATIONS_IDENTIFIED"

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "All reviews refreshed against current evidence"
        }
    )

    assert response.status_code == 200
    gates = response.json()["gates"]
    assert gates["proof_snapshot_matches"] is True
    assert gates["verification_snapshot_matches"] is True
    assert gates["adversarial_snapshot_matches"] is True


# PACTORA STICKY INVALIDATION REGRESSION TESTS

def _invalidate_test_commitment(client):
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    details = client.get(f"/commitments/{commitment_id}").json()
    evidence_path = details["evidence"][0]["stored_path"]

    with open(evidence_path, "ab") as file:
        file.write(b"\ntampered=true")

    response = client.post(f"/commitments/{commitment_id}/verify")
    assert response.status_code == 200
    assert response.json()["commitment_status"] == "INVALIDATED"
    return commitment_id


def test_invalidated_commitment_rejects_new_evidence(client):
    commitment_id = _invalidate_test_commitment(client)

    before = client.get(f"/commitments/{commitment_id}").json()
    response = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={"filename": "replacement.txt", "content": "replacement evidence"}
    )
    after = client.get(f"/commitments/{commitment_id}").json()

    assert response.status_code == 409
    assert after["commitment"]["status"] == "INVALIDATED"
    assert len(after["evidence"]) == len(before["evidence"])


def test_reverification_cannot_restore_invalidated_commitment(client):
    commitment_id = _invalidate_test_commitment(client)

    response = client.post(f"/commitments/{commitment_id}/verify")
    details = client.get(f"/commitments/{commitment_id}").json()

    assert response.status_code == 200
    assert response.json()["commitment_status"] == "INVALIDATED"
    assert details["commitment"]["status"] == "INVALIDATED"


def test_authorized_approval_is_blocked_for_invalidated_commitment(
    client, monkeypatch
):
    configure_approver(monkeypatch)
    commitment_id = _invalidate_test_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "Regression test for sticky invalidation"
        }
    )

    details = client.get(f"/commitments/{commitment_id}").json()

    assert response.status_code == 409
    assert details["commitment"]["status"] == "INVALIDATED"

# ============================================================
# SECURITY HARDENING REGRESSION TESTS
# ============================================================

COMMITMENT_BODY = {
    "title": "Customer Data Encryption",
    "claim": "Customer data is encrypted at rest.",
    "owner": "Security Engineering",
    "acceptance_criteria": (
        "Approved storage configuration demonstrates encryption enabled."
    ),
}


def _dependency_requires_auth(dependency):
    if getattr(dependency.call, "pactora_requires_auth", False):
        return True
    return any(
        _dependency_requires_auth(child)
        for child in dependency.dependencies
    )


def test_every_sensitive_route_declares_authentication():
    public_paths = {"/", "/health"}
    docs_paths = {
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
        "/openapi.json",
    }

    for route in main.app.routes:
        if not isinstance(route, APIRoute):
            continue
        if route.path in public_paths or route.path in docs_paths:
            continue

        assert _dependency_requires_auth(route.dependant), route.path


def test_unauthenticated_requests_are_rejected(multi_client):
    client = multi_client
    commitment_id = create_commitment(client)

    cases = [
        ("GET", "/commitments", None),
        ("POST", "/commitments", COMMITMENT_BODY),
        ("GET", f"/commitments/{commitment_id}", None),
        ("GET", f"/commitments/{commitment_id}/audit", None),
        ("GET", f"/commitments/{commitment_id}/trust-passport", None),
        ("GET", f"/commitments/{commitment_id}/trust-graph", None),
        ("GET", f"/commitments/{commitment_id}/reviews", None),
        ("GET", f"/commitments/{commitment_id}/approval-history", None),
        ("GET", f"/commitments/{commitment_id}/proof-history", None),
        ("POST", f"/commitments/{commitment_id}/evidence", {
            "filename": "x.txt",
            "content": "x",
        }),
        ("POST", f"/commitments/{commitment_id}/verify", None),
        ("POST", f"/commitments/{commitment_id}/proof-checks", {
            "checks": [],
        }),
        ("POST", f"/commitments/{commitment_id}/evaluate", None),
        ("POST", f"/commitments/{commitment_id}/independent-review", None),
        ("POST", f"/commitments/{commitment_id}/adversarial-review", None),
        ("POST", f"/commitments/{commitment_id}/dependencies", {
            "depends_on_id": "PACT-DOES-NOT-EXIST",
        }),
        ("POST", f"/commitments/{commitment_id}/reopen", {
            "reason": "unauthorized reopen",
        }),
        ("POST", f"/commitments/{commitment_id}/trust-scan", None),
        ("POST", f"/commitments/{commitment_id}/approval", {
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "unauthorized approval attempt",
        }),
        ("GET", "/trust-graph", None),
    ]

    for method, path, body in cases:
        kwargs = {"headers": {"X-API-Key": "not-a-real-key"}}
        if body is not None:
            kwargs["json"] = body
        response = client.request(method, path, **kwargs)
        assert response.status_code == 401, (method, path, response.text)


def test_owner_cannot_read_or_list_another_owners_commitment(multi_client):
    client = multi_client

    created = client.post(
        "/commitments",
        headers=auth_headers("owner-a"),
        json=COMMITMENT_BODY,
    )
    assert created.status_code == 200
    commitment_id = created.json()["commitment_id"]

    assert client.get(
        f"/commitments/{commitment_id}",
        headers=auth_headers("owner-b"),
    ).status_code == 404

    assert client.get(
        f"/commitments/{commitment_id}",
        headers=auth_headers("owner-a"),
    ).status_code == 200

    assert client.get(
        f"/commitments/{commitment_id}",
        headers=auth_headers("admin"),
    ).status_code == 200

    owner_b_list = client.get(
        "/commitments", headers=auth_headers("owner-b")
    ).json()
    assert all(item["id"] != commitment_id for item in owner_b_list)

    owner_a_list = client.get(
        "/commitments", headers=auth_headers("owner-a")
    ).json()
    assert any(item["id"] == commitment_id for item in owner_a_list)


def test_dependency_creation_is_scoped_to_commitment_owner(multi_client):
    client = multi_client

    owner_a_id = client.post(
        "/commitments",
        headers=auth_headers("owner-a"),
        json=COMMITMENT_BODY,
    ).json()["commitment_id"]

    owner_b_id = client.post(
        "/commitments",
        headers=auth_headers("owner-b"),
        json=COMMITMENT_BODY,
    ).json()["commitment_id"]

    denied = client.post(
        f"/commitments/{owner_a_id}/dependencies",
        headers=auth_headers("owner-b"),
        json={"depends_on_id": owner_b_id},
    )
    assert denied.status_code == 404

    allowed = client.post(
        f"/commitments/{owner_a_id}/dependencies",
        headers=auth_headers("owner-a"),
        json={"depends_on_id": owner_b_id},
    )
    assert allowed.status_code == 200
    assert allowed.json()["relationship"] == "DEPENDS_ON"


def test_dependency_rejects_invalidated_prerequisite(client):
    dependent_id = create_commitment(client)
    invalidated_id = _invalidate_test_commitment(client)

    response = client.post(
        f"/commitments/{dependent_id}/dependencies",
        json={"depends_on_id": invalidated_id},
    )

    assert response.status_code == 409


def test_trust_scan_requires_service_or_admin(multi_client):
    client = multi_client
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    for role in ("owner-a", "owner-b", "reviewer", "approver"):
        response = client.post(
            f"/commitments/{commitment_id}/trust-scan",
            headers=auth_headers(role),
        )
        assert response.status_code == 403, role

    service_scan = client.post(
        f"/commitments/{commitment_id}/trust-scan",
        headers=auth_headers("service"),
    )
    assert service_scan.status_code == 200
    assert service_scan.json()["trust_status"] == "INTACT"

    admin_scan = client.post(
        f"/commitments/{commitment_id}/trust-scan",
        headers=auth_headers("admin"),
    )
    assert admin_scan.status_code == 200


def test_trust_scan_dry_run_does_not_mutate_commitment(multi_client):
    client = multi_client
    commitment_id = create_commitment(client)
    attach_evidence(client, commitment_id)

    evidence_path = get_evidence_path(commitment_id)
    with open(evidence_path, "ab") as file:
        file.write(b"\ntampered=true")

    dry_run = client.post(
        f"/commitments/{commitment_id}/trust-scan?dry_run=true",
        headers=auth_headers("service"),
    )

    assert dry_run.status_code == 200
    assert dry_run.json()["dry_run"] is True
    assert dry_run.json()["trust_status"] == "COLLAPSED"
    assert commitment_id in dry_run.json()["affected_commitments"]

    unchanged = client.get(
        f"/commitments/{commitment_id}",
        headers=auth_headers("admin"),
    ).json()
    assert unchanged["commitment"]["status"] == "UNDER_REVIEW"

    actual = client.post(
        f"/commitments/{commitment_id}/trust-scan",
        headers=auth_headers("service"),
    )
    assert actual.status_code == 200
    assert actual.json()["dry_run"] is False
    assert actual.json()["trust_status"] == "COLLAPSED"

    invalidated = client.get(
        f"/commitments/{commitment_id}",
        headers=auth_headers("admin"),
    ).json()
    assert invalidated["commitment"]["status"] == "INVALIDATED"


def test_approved_commitment_blocks_downgrade_paths_and_can_reopen(
    client, monkeypatch
):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)
    prepare_approval_gates(client, commitment_id)

    approved = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "All gates passed for approval regression test",
        },
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "APPROVED"

    evidence = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={"filename": "late.txt", "content": "late evidence"},
    )
    assert evidence.status_code == 409

    verification = client.post(f"/commitments/{commitment_id}/verify")
    assert verification.status_code == 409

    second_approval = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=approval_headers(),
        json={
            "approver_id": "security.manager",
            "decision": "APPROVE",
            "reason": "Second approval should be blocked",
        },
    )
    assert second_approval.status_code == 409

    other_id = create_commitment(client)
    dependency = client.post(
        f"/commitments/{commitment_id}/dependencies",
        json={"depends_on_id": other_id},
    )
    assert dependency.status_code == 409

    details = client.get(f"/commitments/{commitment_id}").json()
    assert details["commitment"]["status"] == "APPROVED"

    reopened = client.post(
        f"/commitments/{commitment_id}/reopen",
        json={"reason": "New evidence must be incorporated"},
    )
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "REOPENED"

    after_reopen = client.get(f"/commitments/{commitment_id}").json()
    assert after_reopen["commitment"]["status"] == "REOPENED"

    evidence_after_reopen = client.post(
        f"/commitments/{commitment_id}/evidence",
        json={"filename": "reopened.txt", "content": "new evidence"},
    )
    assert evidence_after_reopen.status_code == 200
    assert evidence_after_reopen.json()["status"] == "UNDER_REVIEW"

    second_reopen = client.post(
        f"/commitments/{commitment_id}/reopen",
        json={"reason": "Cannot reopen twice without approval"},
    )
    assert second_reopen.status_code == 409


def test_invalidated_commitment_cannot_be_reopened(client):
    commitment_id = _invalidate_test_commitment(client)

    response = client.post(
        f"/commitments/{commitment_id}/reopen",
        json={"reason": "Attempt to bypass re-attestation"},
    )

    assert response.status_code == 409
    details = client.get(f"/commitments/{commitment_id}").json()
    assert details["commitment"]["status"] == "INVALIDATED"


def test_approval_requires_approver_role(multi_client, monkeypatch):
    configure_approver(monkeypatch)
    client = multi_client
    commitment_id = create_commitment(client)
    prepare_approval_gates(client, commitment_id)

    approval_body = {
        "approver_id": "security.manager",
        "decision": "APPROVE",
        "reason": "Role enforcement regression test",
    }

    for role in ("owner-a", "reviewer", "service"):
        response = client.post(
            f"/commitments/{commitment_id}/approval",
            headers=auth_headers(role, **approval_headers()),
            json=approval_body,
        )
        assert response.status_code == 403, role

    approved = client.post(
        f"/commitments/{commitment_id}/approval",
        headers=auth_headers("approver", **approval_headers()),
        json=approval_body,
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "APPROVED"


def test_approval_is_atomic_when_audit_write_fails(client, monkeypatch):
    configure_approver(monkeypatch)
    commitment_id = create_commitment(client)
    prepare_approval_gates(client, commitment_id)

    def failing_audit_row(*args, **kwargs):
        raise RuntimeError("simulated audit failure")

    monkeypatch.setattr(main, "audit_row", failing_audit_row)

    with pytest.raises(RuntimeError):
        client.post(
            f"/commitments/{commitment_id}/approval",
            headers=approval_headers(),
            json={
                "approver_id": "security.manager",
                "decision": "APPROVE",
                "reason": "Audit failure must roll back approval",
            },
        )

    details = client.get(f"/commitments/{commitment_id}").json()
    assert details["commitment"]["status"] != "APPROVED"

    history = client.get(
        f"/commitments/{commitment_id}/approval-history"
    ).json()
    assert history == []


def test_audit_events_include_actor_and_request_id(multi_client):
    client = multi_client

    created = client.post(
        "/commitments",
        headers=auth_headers("owner-a", **{"X-Request-ID": "REQ-SECURITY-TEST"}),
        json=COMMITMENT_BODY,
    )
    assert created.status_code == 200
    assert created.headers.get("X-Request-ID") == "REQ-SECURITY-TEST"
    commitment_id = created.json()["commitment_id"]

    audit = client.get(
        f"/commitments/{commitment_id}/audit",
        headers=auth_headers("owner-a"),
    ).json()

    created_events = [
        event for event in audit
        if event["event_type"] == "COMMITMENT_CREATED"
    ]
    assert len(created_events) == 1

    details = created_events[0]["details"]
    assert details["actor"] == {
        "id": "owner-a",
        "role": "owner",
        "name": "Owner A",
    }
    assert details["request_id"] == "REQ-SECURITY-TEST"
