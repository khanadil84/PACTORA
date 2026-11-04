import hashlib
import json
import sqlite3
import uuid

from datetime import datetime, timezone
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
EVIDENCE_DIR = BASE_DIR / "evidence"

DATA_DIR.mkdir(exist_ok=True)
EVIDENCE_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "pactora.db"

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    initialize_proof_tables()
    yield


app = FastAPI(
    title="PACTORA CORE",
    description="Proof-Carrying Commitment Network",
    version="0.1.0",
    lifespan=lifespan
)


def now():
    return datetime.now(timezone.utc).isoformat()


def connect():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS commitments (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                claim TEXT NOT NULL,
                owner TEXT NOT NULL,
                acceptance_criteria TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS evidence (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(commitment_id) REFERENCES commitments(id)
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)


def audit(commitment_id, event_type, details):
    with connect() as db:
        db.execute(
            """INSERT INTO audit_events
            VALUES (?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                commitment_id,
                event_type,
                json.dumps(details),
                now()
            )
        )


class CommitmentInput(BaseModel):
    title: str = Field(min_length=3, max_length=150)
    claim: str = Field(min_length=5, max_length=2000)
    owner: str = Field(min_length=2, max_length=100)
    acceptance_criteria: str = Field(min_length=5, max_length=2000)


class EvidenceInput(BaseModel):
    filename: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=100000)


@app.get("/")
def root():
    return {
        "product": "PACTORA",
        "module": "PACTORA CORE",
        "version": "0.1.0",
        "principle": "Proof over promises"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "database": DB_PATH.exists(),
        "timestamp": now()
    }


@app.post("/commitments")
def create_commitment(payload: CommitmentInput):
    commitment_id = "PACT-" + uuid.uuid4().hex[:12].upper()

    with connect() as db:
        db.execute(
            """INSERT INTO commitments
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                commitment_id,
                payload.title,
                payload.claim,
                payload.owner,
                payload.acceptance_criteria,
                "EVIDENCE_PENDING",
                now()
            )
        )

    audit(commitment_id, "COMMITMENT_CREATED", {
        "title": payload.title,
        "owner": payload.owner
    })

    return {
        "commitment_id": commitment_id,
        "status": "EVIDENCE_PENDING",
        "message": "Commitment created successfully."
    }


@app.get("/commitments")
def list_commitments():
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM commitments ORDER BY created_at DESC"
        ).fetchall()

    return [dict(row) for row in rows]


@app.get("/commitments/{commitment_id}")
def get_commitment(commitment_id: str):
    with connect() as db:
        row = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not row:
            raise HTTPException(404, "Commitment not found.")

        evidence = db.execute(
            "SELECT * FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    return {
        "commitment": dict(row),
        "evidence": [dict(item) for item in evidence]
    }


@app.post("/commitments/{commitment_id}/evidence")
def attach_evidence(commitment_id: str, payload: EvidenceInput):
    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

    if not commitment:
        raise HTTPException(404, "Commitment not found.")

    evidence_id = "EVD-" + uuid.uuid4().hex[:12].upper()

    # Store evidence under a generated filename, never the supplied path.
    safe_name = evidence_id + ".txt"
    evidence_path = EVIDENCE_DIR / safe_name

    content = payload.content.encode("utf-8")
    fingerprint = hashlib.sha256(content).hexdigest()

    evidence_path.write_bytes(content)

    with connect() as db:
        db.execute(
            """INSERT INTO evidence
            VALUES (?, ?, ?, ?, ?, ?)""",
            (
                evidence_id,
                commitment_id,
                payload.filename,
                str(evidence_path),
                fingerprint,
                now()
            )
        )

        db.execute(
            "UPDATE commitments SET status = ? WHERE id = ?",
            ("UNDER_REVIEW", commitment_id)
        )

    audit(commitment_id, "EVIDENCE_ATTACHED", {
        "evidence_id": evidence_id,
        "sha256": fingerprint
    })

    return {
        "evidence_id": evidence_id,
        "sha256": fingerprint,
        "status": "UNDER_REVIEW",
        "message": "Evidence stored and fingerprint generated."
    }


@app.post("/commitments/{commitment_id}/verify")
def verify_evidence(commitment_id: str):
    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        evidence_items = db.execute(
            "SELECT * FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    if not evidence_items:
        raise HTTPException(400, "No evidence attached.")

    results = []

    for item in evidence_items:
        path = Path(item["stored_path"])

        if not path.is_file():
            results.append({
                "evidence_id": item["id"],
                "integrity": "FAILED",
                "reason": "Evidence file missing."
            })
            continue

        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        matches = actual_hash == item["sha256"]

        results.append({
            "evidence_id": item["id"],
            "integrity": "PASS" if matches else "FAILED",
            "expected_sha256": item["sha256"],
            "actual_sha256": actual_hash
        })

    all_pass = all(
        result["integrity"] == "PASS" for result in results
    )

    status = (
        "UNDER_REVIEW"
        if all_pass
        else "INVALIDATED"
    )

    with connect() as db:
        db.execute(
            "UPDATE commitments SET status = ? WHERE id = ?",
            (status, commitment_id)
        )

    audit(commitment_id, "EVIDENCE_INTEGRITY_CHECK", {
        "results": results,
        "all_pass": all_pass
    })

    return {
        "commitment_id": commitment_id,
        "evidence_integrity": "PASS" if all_pass else "FAILED",
        "commitment_status": status,
        "claim_semantically_verified": False,
        "results": results,
        "message": (
            "Evidence integrity passed. Independent claim verification "
            "is still required."
            if all_pass
            else "Evidence integrity failed. Commitment invalidated."
        )
    }


@app.get("/commitments/{commitment_id}/audit")
def get_audit(commitment_id: str):
    with connect() as db:
        rows = db.execute(
            """SELECT * FROM audit_events
            WHERE commitment_id = ?
            ORDER BY created_at ASC""",
            (commitment_id,)
        ).fetchall()

    return [
        {
            **dict(row),
            "details": json.loads(row["details"])
        }
        for row in rows
    ]




# ============================================================
# PACTORA PROOF ENGINE
# Deterministic checks against explicitly identified evidence.
# ============================================================

def initialize_proof_tables():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_checks (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                evidence_id TEXT NOT NULL,
                name TEXT NOT NULL,
                operator TEXT NOT NULL,
                expected_value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(commitment_id) REFERENCES commitments(id),
                FOREIGN KEY(evidence_id) REFERENCES evidence(id)
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS verification_reviews (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                result TEXT NOT NULL,
                details TEXT NOT NULL,
                reviewer_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS adversarial_reviews (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                result TEXT NOT NULL,
                findings TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_evaluations (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                result TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(commitment_id) REFERENCES commitments(id)
            )
        """)


class ProofCheckInput(BaseModel):
    evidence_id: str = Field(min_length=5, max_length=50)
    name: str = Field(min_length=3, max_length=150)
    operator: str = Field(min_length=1, max_length=20)
    expected_value: str = Field(min_length=1, max_length=2000)


class ProofChecksInput(BaseModel):
    checks: list[ProofCheckInput] = Field(min_length=1, max_length=25)


@app.post("/commitments/{commitment_id}/proof-checks")
def create_proof_checks(commitment_id: str, payload: ProofChecksInput):

    allowed_operators = {"contains", "equals"}

    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        for check in payload.checks:
            if check.operator not in allowed_operators:
                raise HTTPException(
                    422,
                    "Unsupported operator. Use contains or equals."
                )

            evidence = db.execute(
                """SELECT id FROM evidence
                WHERE id = ? AND commitment_id = ?""",
                (check.evidence_id, commitment_id)
            ).fetchone()

            if not evidence:
                raise HTTPException(
                    400,
                    f"Evidence {check.evidence_id} does not belong to this commitment."
                )

        created = []

        for check in payload.checks:
            check_id = "CHK-" + uuid.uuid4().hex[:12].upper()

            db.execute(
                """INSERT INTO proof_checks
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    check_id,
                    commitment_id,
                    check.evidence_id,
                    check.name,
                    check.operator,
                    check.expected_value,
                    now()
                )
            )

            created.append({
                "check_id": check_id,
                "name": check.name,
                "operator": check.operator,
                "evidence_id": check.evidence_id
            })

    audit(commitment_id, "PROOF_CHECKS_CREATED", {
        "checks": created
    })

    return {
        "commitment_id": commitment_id,
        "checks_created": len(created),
        "checks": created
    }


@app.post("/commitments/{commitment_id}/evaluate")
def evaluate_commitment(commitment_id: str):

    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        checks = db.execute(
            """SELECT * FROM proof_checks
            WHERE commitment_id = ?
            ORDER BY created_at ASC""",
            (commitment_id,)
        ).fetchall()

    if not checks:
        raise HTTPException(
            400,
            "No proof checks defined for this commitment."
        )

    results = []

    for check in checks:
        with connect() as db:
            evidence = db.execute(
                "SELECT * FROM evidence WHERE id = ?",
                (check["evidence_id"],)
            ).fetchone()

        if not evidence:
            outcome = "INCONCLUSIVE"
            reason = "Referenced evidence record is missing."

        else:
            evidence_path = Path(evidence["stored_path"])

            if not evidence_path.is_file():
                outcome = "INCONCLUSIVE"
                reason = "Evidence file is missing."

            else:
                content = evidence_path.read_text(
                    encoding="utf-8"
                )

                actual_hash = hashlib.sha256(
                    evidence_path.read_bytes()
                ).hexdigest()

                if actual_hash != evidence["sha256"]:
                    outcome = "INCONCLUSIVE"
                    reason = "Evidence integrity failed. Content cannot be trusted."

                elif check["operator"] == "contains":
                    passed = check["expected_value"] in content
                    outcome = "PASS" if passed else "FAIL"
                    reason = (
                        "Expected text was found."
                        if passed
                        else "Expected text was not found."
                    )

                elif check["operator"] == "equals":
                    passed = content.strip() == check["expected_value"].strip()
                    outcome = "PASS" if passed else "FAIL"
                    reason = (
                        "Evidence content matches the expected value."
                        if passed
                        else "Evidence content does not match the expected value."
                    )

                else:
                    outcome = "INCONCLUSIVE"
                    reason = "Unsupported proof operator."

        results.append({
            "check_id": check["id"],
            "name": check["name"],
            "evidence_id": check["evidence_id"],
            "operator": check["operator"],
            "outcome": outcome,
            "reason": reason
        })

    outcomes = [item["outcome"] for item in results]

    if all(item == "PASS" for item in outcomes):
        overall = "PASS"
    elif any(item == "FAIL" for item in outcomes):
        overall = "FAIL"
    else:
        overall = "INCONCLUSIVE"

    evaluation_id = "PRF-" + uuid.uuid4().hex[:12].upper()
    evaluated_at = now()

    with connect() as db:
        db.execute(
            """INSERT INTO proof_evaluations
            VALUES (?, ?, ?, ?, ?)""",
            (
                evaluation_id,
                commitment_id,
                overall,
                json.dumps(results),
                evaluated_at
            )
        )

    audit(commitment_id, "PROOF_EVALUATED", {
        "evaluation_id": evaluation_id,
        "result": overall,
        "checks": results
    })

    return {
        "evaluation_id": evaluation_id,
        "commitment_id": commitment_id,
        "result": overall,
        "claim_semantically_verified": False,
        "evaluated_at": evaluated_at,
        "checks": results,
        "interpretation": (
            "All configured deterministic checks passed. "
            "This does not independently establish the truth of the business claim."
        )
    }


@app.get("/commitments/{commitment_id}/proof-history")
def get_proof_history(commitment_id: str):

    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        rows = db.execute(
            """SELECT * FROM proof_evaluations
            WHERE commitment_id = ?
            ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

    return [
        {
            "evaluation_id": row["id"],
            "result": row["result"],
            "details": json.loads(row["details"]),
            "created_at": row["created_at"]
        }
        for row in rows
    ]



# ============================================================
# INDEPENDENT VERIFICATION
# Re-evaluates configured checks without trusting saved results.
# ============================================================

@app.post("/commitments/{commitment_id}/independent-review")
def independent_review(commitment_id: str):

    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        checks = db.execute(
            "SELECT * FROM proof_checks WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    if not checks:
        raise HTTPException(400, "No proof checks available.")

    results = []

    for check in checks:
        with connect() as db:
            evidence = db.execute(
                "SELECT * FROM evidence WHERE id = ? AND commitment_id = ?",
                (check["evidence_id"], commitment_id)
            ).fetchone()

        outcome = "INCONCLUSIVE"
        reason = "Evidence could not be independently evaluated."

        if evidence:
            path = Path(evidence["stored_path"])

            if path.is_file():
                raw = path.read_bytes()
                actual_hash = hashlib.sha256(raw).hexdigest()

                if actual_hash != evidence["sha256"]:
                    reason = "Evidence fingerprint mismatch."
                else:
                    content = raw.decode("utf-8")

                    if check["operator"] == "contains":
                        passed = check["expected_value"] in content
                    elif check["operator"] == "equals":
                        passed = content.strip() == check["expected_value"].strip()
                    else:
                        passed = None

                    if passed is not None:
                        outcome = "PASS" if passed else "FAIL"
                        reason = (
                            "Independent configured check passed."
                            if passed
                            else "Independent configured check failed."
                        )

        results.append({
            "check_id": check["id"],
            "evidence_id": check["evidence_id"],
            "outcome": outcome,
            "reason": reason
        })

    outcomes = [item["outcome"] for item in results]

    if all(item == "PASS" for item in outcomes):
        overall = "PASS"
    elif any(item == "FAIL" for item in outcomes):
        overall = "FAIL"
    else:
        overall = "INCONCLUSIVE"

    review_id = "REV-" + uuid.uuid4().hex[:12].upper()
    details = {
        "method": "independent_deterministic_recheck",
        "results": results,
        "claim_semantically_verified": False
    }

    with connect() as db:
        db.execute(
            """INSERT INTO verification_reviews
            VALUES (?, ?, ?, ?, ?, ?)""",
            (
                review_id,
                commitment_id,
                overall,
                json.dumps(details),
                "PACTORA_INDEPENDENT_VERIFIER",
                now()
            )
        )

    audit(commitment_id, "INDEPENDENT_REVIEW_COMPLETED", {
        "review_id": review_id,
        "result": overall
    })

    return {
        "review_id": review_id,
        "commitment_id": commitment_id,
        "result": overall,
        **details
    }


# ============================================================
# ADVERSARIAL REVIEW
# Identifies limitations and evidence weaknesses.
# ============================================================

@app.post("/commitments/{commitment_id}/adversarial-review")
def adversarial_review(commitment_id: str):

    with connect() as db:
        commitment = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        evidence_items = db.execute(
            "SELECT * FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

        checks = db.execute(
            "SELECT * FROM proof_checks WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    findings = []

    if not evidence_items:
        findings.append({
            "severity": "CRITICAL",
            "code": "NO_EVIDENCE",
            "message": "No evidence is attached."
        })

    if len(evidence_items) == 1:
        findings.append({
            "severity": "WARNING",
            "code": "SINGLE_EVIDENCE_SOURCE",
            "message": "Only one evidence item is available. Independent corroboration is absent."
        })

    if evidence_items and all(
        Path(item["stored_path"]).suffix.lower() in {".txt", ".log", ".json"}
        for item in evidence_items
    ):
        findings.append({
            "severity": "WARNING",
            "code": "TEXT_BASED_EVIDENCE",
            "message": "Evidence consists of text or log files. This does not independently establish real-world truth."
        })

    if not checks:
        findings.append({
            "severity": "CRITICAL",
            "code": "NO_ACCEPTANCE_CHECKS",
            "message": "No explicit deterministic acceptance checks are configured."
        })

    findings.append({
        "severity": "WARNING",
        "code": "SEMANTIC_TRUTH_NOT_ESTABLISHED",
        "message": "Configured checks cannot independently prove the complete business claim."
    })

    critical_count = sum(
        1 for item in findings
        if item["severity"] == "CRITICAL"
    )

    result = "CHALLENGED" if critical_count else "LIMITATIONS_IDENTIFIED"

    review_id = "ADV-" + uuid.uuid4().hex[:12].upper()

    with connect() as db:
        db.execute(
            """INSERT INTO adversarial_reviews
            VALUES (?, ?, ?, ?, ?)""",
            (
                review_id,
                commitment_id,
                result,
                json.dumps(findings),
                now()
            )
        )

    audit(commitment_id, "ADVERSARIAL_REVIEW_COMPLETED", {
        "review_id": review_id,
        "result": result,
        "finding_count": len(findings)
    })

    return {
        "review_id": review_id,
        "commitment_id": commitment_id,
        "result": result,
        "findings": findings,
        "claim_semantically_verified": False
    }


@app.get("/commitments/{commitment_id}/reviews")
def get_reviews(commitment_id: str):

    with connect() as db:
        commitment = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        verification = db.execute(
            """SELECT * FROM verification_reviews
            WHERE commitment_id = ? ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

        adversarial = db.execute(
            """SELECT * FROM adversarial_reviews
            WHERE commitment_id = ? ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

    return {
        "independent_reviews": [
            {
                "review_id": row["id"],
                "result": row["result"],
                "details": json.loads(row["details"]),
                "created_at": row["created_at"]
            }
            for row in verification
        ],
        "adversarial_reviews": [
            {
                "review_id": row["id"],
                "result": row["result"],
                "findings": json.loads(row["findings"]),
                "created_at": row["created_at"]
            }
            for row in adversarial
        ]
    }
