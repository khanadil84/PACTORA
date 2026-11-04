import hashlib

import pytest
from fastapi.testclient import TestClient

from backend.app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    evidence_dir = tmp_path / "evidence"

    data_dir.mkdir()
    evidence_dir.mkdir()

    monkeypatch.setattr(main, "DATA_DIR", data_dir)
    monkeypatch.setattr(main, "EVIDENCE_DIR", evidence_dir)
    monkeypatch.setattr(main, "DB_PATH", data_dir / "test.db")

    with TestClient(main.app) as test_client:
        yield test_client


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
