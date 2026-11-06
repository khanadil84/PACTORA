import contextvars
import hashlib
import hmac
import os
import secrets
import json
import sqlite3
import uuid

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Header, Query, Request
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
EVIDENCE_DIR = BASE_DIR / "evidence"

DATA_DIR.mkdir(exist_ok=True)
EVIDENCE_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "pactora.db"


def _load_local_env():
    """Load backend/.env for local demo runs without overriding real env vars."""
    env_path = BASE_DIR / ".env"

    if not env_path.is_file():
        return

    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for raw_line in lines:
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


_load_local_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    initialize_proof_tables()
    initialize_approval_tables()
    initialize_trust_graph_tables()
    yield


_docs_enabled = os.getenv("PACTORA_ENABLE_DOCS", "").strip().lower() in {
    "1", "true", "yes", "on"
}

app = FastAPI(
    title="PACTORA CORE",
    description="Proof-Carrying Commitment Network",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)


# ============================================================
# LOCAL-DEMO AUTHENTICATION AND REQUEST CONTEXT
# This is intentionally a local-demo API-key model, not a
# production identity provider. It fails closed when no keys
# are configured.
# ============================================================

_request_id_var = contextvars.ContextVar("pactora_request_id", default=None)
_principal_var = contextvars.ContextVar("pactora_principal", default=None)

READ_ROLES = {"admin", "reviewer", "approver", "service"}
REVIEW_ROLES = {"admin", "owner", "reviewer"}

PUBLIC_PATHS = {"/", "/health"}


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    supplied = request.headers.get("X-Request-ID", "").strip()
    request_id = supplied or ("REQ-" + uuid.uuid4().hex[:16].upper())
    token = _request_id_var.set(request_id)

    try:
        response = await call_next(request)
    finally:
        _request_id_var.reset(token)

    response.headers["X-Request-ID"] = request_id
    return response


def _load_api_keys():
    raw = os.getenv("PACTORA_API_KEYS", "").strip()
    keys = {}

    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}

        if isinstance(parsed, dict):
            for key, value in parsed.items():
                if not isinstance(key, str) or not key:
                    continue

                if isinstance(value, str):
                    keys[key] = {
                        "id": value,
                        "role": "admin",
                        "name": value,
                    }
                elif isinstance(value, dict):
                    keys[key] = {
                        "id": str(value.get("id") or value.get("name") or "principal"),
                        "role": str(value.get("role") or "owner"),
                        "name": str(value.get("name") or value.get("id") or "principal"),
                    }

    if not keys:
        single = os.getenv("PACTORA_API_KEY", "").strip()
        if single:
            keys[single] = {
                "id": os.getenv("PACTORA_PRINCIPAL_ID", "local-user"),
                "role": os.getenv("PACTORA_PRINCIPAL_ROLE", "admin"),
                "name": os.getenv("PACTORA_PRINCIPAL_NAME", "Local User"),
            }

    return keys


def _extract_api_key(x_api_key: str, authorization: str) -> str:
    if x_api_key and x_api_key.strip():
        return x_api_key.strip()

    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() in {"bearer", "apikey", "token"}:
            return value.strip()

    return ""


def authenticate_request(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    authorization: str = Header(default="", alias="Authorization"),
):
    keys = _load_api_keys()

    if not keys:
        raise HTTPException(
            503,
            "Authentication is not configured. Set PACTORA_API_KEYS.",
        )

    supplied = _extract_api_key(x_api_key, authorization)

    if not supplied:
        raise HTTPException(401, "Authentication required.")

    matched = None

    for key, principal in keys.items():
        if hmac.compare_digest(supplied, key):
            matched = principal
            break

    if matched is None:
        raise HTTPException(401, "Invalid API key.")

    principal = dict(matched)
    _principal_var.set(principal)
    return principal


def require_roles(*roles):
    allowed = set(roles)

    def dependency(principal: dict = Depends(authenticate_request)):
        if principal.get("role") != "admin" and principal.get("role") not in allowed:
            raise HTTPException(403, "Insufficient permissions.")
        return principal

    dependency.pactora_requires_auth = True
    return dependency


authenticate_request.pactora_requires_auth = True


def _is_admin(principal):
    return bool(principal and principal.get("role") == "admin")


def _principal_id(principal):
    return (principal or {}).get("id", "")


def _can_read_commitment(principal, commitment):
    return (
        _is_admin(principal)
        or principal.get("role") in READ_ROLES
        or commitment["owner"] == _principal_id(principal)
    )


def _can_write_commitment(principal, commitment):
    return (
        _is_admin(principal)
        or commitment["owner"] == _principal_id(principal)
    )


def _can_review_commitment(principal, commitment):
    return (
        _is_admin(principal)
        or principal.get("role") == "reviewer"
        or commitment["owner"] == _principal_id(principal)
    )


def _require_read(principal, commitment):
    if not _can_read_commitment(principal, commitment):
        raise HTTPException(404, "Commitment not found.")


def _require_write(principal, commitment):
    if not _can_write_commitment(principal, commitment):
        raise HTTPException(404, "Commitment not found.")


def _require_review(principal, commitment):
    if not _can_review_commitment(principal, commitment):
        raise HTTPException(404, "Commitment not found.")


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


def _enrich_audit_details(details, principal=None, request_id=None):
    enriched = dict(details) if isinstance(details, dict) else {"details": details}

    actor = principal if principal is not None else _principal_var.get()
    rid = request_id if request_id is not None else _request_id_var.get()

    if actor:
        enriched["actor"] = {
            "id": actor.get("id"),
            "role": actor.get("role"),
            "name": actor.get("name"),
        }

    if rid:
        enriched["request_id"] = rid

    return enriched


def audit_row(
    db,
    commitment_id,
    event_type,
    details,
    principal=None,
    request_id=None,
    created_at=None,
):
    """Insert an audit row using an existing transaction."""
    enriched = _enrich_audit_details(
        details,
        principal=principal,
        request_id=request_id,
    )

    db.execute(
        """INSERT INTO audit_events
        VALUES (?, ?, ?, ?, ?)""",
        (
            str(uuid.uuid4()),
            commitment_id,
            event_type,
            json.dumps(enriched),
            created_at or now(),
        ),
    )


def audit(commitment_id, event_type, details, principal=None, request_id=None):
    with connect() as db:
        audit_row(
            db,
            commitment_id,
            event_type,
            details,
            principal=principal,
            request_id=request_id,
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
def create_commitment(
    payload: CommitmentInput,
    principal: dict = Depends(require_roles("owner")),
):
    commitment_id = "PACT-" + uuid.uuid4().hex[:12].upper()
    owner = payload.owner if _is_admin(principal) else _principal_id(principal)

    with connect() as db:
        db.execute(
            """INSERT INTO commitments
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                commitment_id,
                payload.title,
                payload.claim,
                owner,
                payload.acceptance_criteria,
                "EVIDENCE_PENDING",
                now()
            )
        )

    audit(commitment_id, "COMMITMENT_CREATED", {
        "title": payload.title,
        "owner": owner
    }, principal=principal)

    return {
        "commitment_id": commitment_id,
        "status": "EVIDENCE_PENDING",
        "message": "Commitment created successfully."
    }


@app.get("/commitments")
def list_commitments(principal: dict = Depends(authenticate_request)):
    with connect() as db:
        if principal.get("role") == "owner":
            rows = db.execute(
                """SELECT * FROM commitments
                WHERE owner = ? ORDER BY created_at DESC""",
                (_principal_id(principal),)
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM commitments ORDER BY created_at DESC"
            ).fetchall()

    return [dict(row) for row in rows]


@app.get("/commitments/{commitment_id}")
def get_commitment(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):
    with connect() as db:
        row = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not row:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, row)

        evidence = db.execute(
            "SELECT * FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    return {
        "commitment": dict(row),
        "evidence": [dict(item) for item in evidence]
    }


@app.post("/commitments/{commitment_id}/evidence")
def attach_evidence(
    commitment_id: str,
    payload: EvidenceInput,
    principal: dict = Depends(require_roles("owner")),
):
    with connect() as db:
        commitment = db.execute(
            "SELECT id, status, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

    if not commitment:
        raise HTTPException(404, "Commitment not found.")

    _require_write(principal, commitment)

    if commitment["status"] == "INVALIDATED":
        raise HTTPException(409, "Invalidated commitments are locked. Re-attestation is required.")

    if commitment["status"] == "APPROVED":
        raise HTTPException(
            409,
            "Approved commitments are immutable. Use the authorized reopen workflow first.",
        )

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
    }, principal=principal)

    return {
        "evidence_id": evidence_id,
        "sha256": fingerprint,
        "status": "UNDER_REVIEW",
        "message": "Evidence stored and fingerprint generated."
    }


@app.post("/commitments/{commitment_id}/verify")
def verify_evidence(
    commitment_id: str,
    principal: dict = Depends(require_roles("owner")),
):
    with connect() as db:
        commitment = db.execute(
            "SELECT id, status, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_write(principal, commitment)

        if commitment["status"] == "APPROVED":
            raise HTTPException(
                409,
                "Approved commitments are immutable. Use the authorized reopen workflow first.",
            )

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
        "INVALIDATED"
        if commitment["status"] == "INVALIDATED" or not all_pass
        else "UNDER_REVIEW"
    )

    with connect() as db:
        db.execute(
            "UPDATE commitments SET status = ? WHERE id = ?",
            (status, commitment_id)
        )

    audit(commitment_id, "EVIDENCE_INTEGRITY_CHECK", {
        "results": results,
        "all_pass": all_pass
    }, principal=principal)

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
def get_audit(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):
    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

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

        db.execute("""
            CREATE TABLE IF NOT EXISTS review_evidence_snapshots (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                review_type TEXT NOT NULL,
                review_id TEXT NOT NULL,
                snapshot_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(review_type, review_id)
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_review_snapshots_commitment
            ON review_evidence_snapshots(commitment_id, review_type)
        """)


def evidence_state(db, commitment_id):
    """Read evidence once and return both integrity results and snapshot data."""
    rows = db.execute(
        """SELECT * FROM evidence
        WHERE commitment_id = ? ORDER BY id""",
        (commitment_id,)
    ).fetchall()

    results = []
    snapshot = []

    for item in rows:
        path = Path(item["stored_path"])
        actual_hash = None

        if not path.is_file():
            integrity = "FAILED"
            reason = "Evidence file is missing."
            snapshot_actual = "MISSING"
        else:
            try:
                actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
                integrity = (
                    "PASS"
                    if actual_hash == item["sha256"]
                    else "FAILED"
                )
                reason = (
                    "Evidence fingerprint matches."
                    if integrity == "PASS"
                    else "Evidence fingerprint mismatch. Possible tampering detected."
                )
                snapshot_actual = actual_hash
            except OSError as exc:
                integrity = "FAILED"
                reason = f"Evidence could not be read: {type(exc).__name__}"
                snapshot_actual = "READ_ERROR"

        results.append({
            "evidence_id": item["id"],
            "filename": item["filename"],
            "integrity": integrity,
            "expected_sha256": item["sha256"],
            "actual_sha256": actual_hash,
            "reason": reason,
        })

        snapshot.append({
            "evidence_id": item["id"],
            "recorded_sha256": item["sha256"],
            "actual_sha256": snapshot_actual,
        })

    return results, snapshot


def _snapshot_hash(snapshot):
    encoded = json.dumps(
        snapshot, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def evidence_snapshot_hash(db, commitment_id):
    _, snapshot = evidence_state(db, commitment_id)
    return _snapshot_hash(snapshot)


def record_review_snapshot(db, commitment_id, review_type, review_id, created_at):
    fingerprint = evidence_snapshot_hash(db, commitment_id)
    db.execute(
        """INSERT INTO review_evidence_snapshots
        (id, commitment_id, review_type, review_id, snapshot_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (
            "SNP-" + uuid.uuid4().hex[:12].upper(),
            commitment_id,
            review_type,
            review_id,
            fingerprint,
            created_at
        )
    )
    return fingerprint



class ProofCheckInput(BaseModel):
    evidence_id: str = Field(min_length=5, max_length=50)
    name: str = Field(min_length=3, max_length=150)
    operator: str = Field(min_length=1, max_length=20)
    expected_value: str = Field(min_length=1, max_length=2000)


class ProofChecksInput(BaseModel):
    checks: list[ProofCheckInput] = Field(min_length=1, max_length=25)


@app.post("/commitments/{commitment_id}/proof-checks")
def create_proof_checks(
    commitment_id: str,
    payload: ProofChecksInput,
    principal: dict = Depends(require_roles("owner")),
):

    allowed_operators = {"contains", "equals"}

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_write(principal, commitment)

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
    }, principal=principal)

    return {
        "commitment_id": commitment_id,
        "checks_created": len(created),
        "checks": created
    }


@app.post("/commitments/{commitment_id}/evaluate")
def evaluate_commitment(
    commitment_id: str,
    principal: dict = Depends(require_roles("owner", "reviewer")),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_review(principal, commitment)

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
        record_review_snapshot(
            db, commitment_id, "PROOF", evaluation_id, evaluated_at
        )

    audit(commitment_id, "PROOF_EVALUATED", {
        "evaluation_id": evaluation_id,
        "result": overall,
        "checks": results
    }, principal=principal)

    return {
        "evaluation_id": evaluation_id,
        "commitment_id": commitment_id,
        "result": overall,
        "claim_semantically_verified": False,
        "evaluated_at": evaluated_at,
        "checks": results,
        "interpretation": (
            "All configured deterministic checks passed. This does not independently establish the truth of the business claim."
            if overall == "PASS"
            else "One or more configured deterministic checks failed. The business claim is not established."
            if overall == "FAIL"
            else "The evaluation was inconclusive. The business claim is not established."
        )
    }


@app.get("/commitments/{commitment_id}/proof-history")
def get_proof_history(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

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
def independent_review(
    commitment_id: str,
    principal: dict = Depends(require_roles("owner", "reviewer")),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_review(principal, commitment)

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
        record_review_snapshot(
            db, commitment_id, "VERIFICATION", review_id, now()
        )

    audit(commitment_id, "INDEPENDENT_REVIEW_COMPLETED", {
        "review_id": review_id,
        "result": overall
    }, principal=principal)

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
def adversarial_review(
    commitment_id: str,
    principal: dict = Depends(require_roles("owner", "reviewer")),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_review(principal, commitment)

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
        record_review_snapshot(
            db, commitment_id, "ADVERSARIAL", review_id, now()
        )

    audit(commitment_id, "ADVERSARIAL_REVIEW_COMPLETED", {
        "review_id": review_id,
        "result": result,
        "finding_count": len(findings)
    }, principal=principal)

    return {
        "review_id": review_id,
        "commitment_id": commitment_id,
        "result": result,
        "findings": findings,
        "claim_semantically_verified": False
    }


@app.get("/commitments/{commitment_id}/reviews")
def get_reviews(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

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


# ============================================================
# PACTORA HUMAN APPROVAL ENGINE
# Separate human authorization from technical verification.
# ============================================================

def initialize_approval_tables():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS approval_history (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                approver_id TEXT NOT NULL,
                decision TEXT NOT NULL,
                reason TEXT NOT NULL,
                gate_snapshot TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(commitment_id) REFERENCES commitments(id)
            )
        """)


class ApprovalInput(BaseModel):
    approver_id: str = Field(min_length=2, max_length=100)
    decision: str = Field(min_length=6, max_length=7)
    reason: str = Field(min_length=5, max_length=2000)


class ReopenInput(BaseModel):
    reason: str = Field(min_length=5, max_length=2000)


@app.post("/commitments/{commitment_id}/approval")
def decide_approval(
    commitment_id: str,
    payload: ApprovalInput,
    approval_token: str = Header(default="", alias="X-Approval-Token"),
    principal: dict = Depends(require_roles("approver")),
):
    configured_approver = os.getenv("PACTORA_APPROVER_ID")
    configured_token = os.getenv("PACTORA_APPROVAL_TOKEN")

    if not configured_approver or not configured_token:
        raise HTTPException(
            503,
            "Human approval is not configured. Set the approver ID and approval token."
        )

    if (
        payload.approver_id != configured_approver
        or not secrets.compare_digest(approval_token, configured_token)
    ):
        raise HTTPException(403, "Approver authorization failed.")

    decision = payload.decision.upper()

    if decision not in {"APPROVE", "REJECT"}:
        raise HTTPException(
            422,
            "Decision must be APPROVE or REJECT."
        )

    rejection = None
    gates = None
    approval_id = None
    created_at = now()

    # One write transaction covers evidence validation, snapshot checks,
    # the approval history row, the status change, and the audit event.
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")

        commitment = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        if commitment["status"] == "INVALIDATED":
            raise HTTPException(
                409,
                "Approval or rejection blocked. Invalidated commitments require an authorized re-attestation workflow."
            )

        if commitment["status"] == "APPROVED":
            raise HTTPException(
                409,
                "Commitment is already approved. Use the authorized reopen workflow first."
            )

        current_evidence, current_snapshot_data = evidence_state(
            db, commitment_id
        )
        current_snapshot = _snapshot_hash(current_snapshot_data)

        if decision == "APPROVE" and (
            not current_evidence
            or any(
                item["integrity"] != "PASS"
                for item in current_evidence
            )
        ):
            failed_evidence = [
                item for item in current_evidence
                if item["integrity"] != "PASS"
            ]

            db.execute(
                "UPDATE commitments SET status = ? WHERE id = ?",
                ("INVALIDATED", commitment_id)
            )

            audit_row(
                db,
                commitment_id,
                "TRUST_COLLAPSE_DETECTED",
                {
                    "reason": "Approval blocked by current evidence integrity check.",
                    "affected_evidence": failed_evidence,
                    "new_status": "INVALIDATED",
                },
                principal=principal,
                created_at=created_at,
            )

            db.commit()

            rejection = (
                409,
                {
                    "message": "Approval blocked. Current evidence integrity has not passed.",
                    "trust_status": "COLLAPSED",
                    "affected_evidence": failed_evidence,
                },
            )
        else:
            latest_proof = db.execute(
                """SELECT id, result FROM proof_evaluations
                WHERE commitment_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (commitment_id,)
            ).fetchone()

            latest_verification = db.execute(
                """SELECT id, result FROM verification_reviews
                WHERE commitment_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (commitment_id,)
            ).fetchone()

            latest_adversarial = db.execute(
                """SELECT id, result, findings FROM adversarial_reviews
                WHERE commitment_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (commitment_id,)
            ).fetchone()

            def snapshot_matches(review_type, review):
                if review is None:
                    return False
                stored = db.execute(
                    """SELECT snapshot_hash FROM review_evidence_snapshots
                    WHERE commitment_id = ? AND review_type = ? AND review_id = ?""",
                    (commitment_id, review_type, review["id"])
                ).fetchone()
                return bool(
                    stored and stored["snapshot_hash"] == current_snapshot
                )

            proof_snapshot_matches = snapshot_matches(
                "PROOF", latest_proof
            )
            verification_snapshot_matches = snapshot_matches(
                "VERIFICATION", latest_verification
            )
            adversarial_snapshot_matches = snapshot_matches(
                "ADVERSARIAL", latest_adversarial
            )

            critical_findings = []

            if latest_adversarial:
                findings = json.loads(latest_adversarial["findings"])
                critical_findings = [
                    finding for finding in findings
                    if finding.get("severity") == "CRITICAL"
                ]

            gates = {
                "proof_evaluation": (
                    latest_proof["result"] if latest_proof else None
                ),
                "independent_verification": (
                    latest_verification["result"]
                    if latest_verification else None
                ),
                "adversarial_review_exists": latest_adversarial is not None,
                "adversarial_result": (
                    latest_adversarial["result"]
                    if latest_adversarial else None
                ),
                "unresolved_critical_findings": critical_findings,
                "evidence_snapshot": current_snapshot,
                "evidence_set_hash": current_snapshot,
                "proof_snapshot_matches": proof_snapshot_matches,
                "verification_snapshot_matches": verification_snapshot_matches,
                "adversarial_snapshot_matches": adversarial_snapshot_matches,
            }

            eligible = (
                latest_proof is not None
                and latest_proof["result"] == "PASS"
                and latest_verification is not None
                and latest_verification["result"] == "PASS"
                and latest_adversarial is not None
                and len(critical_findings) == 0
                and proof_snapshot_matches
                and verification_snapshot_matches
                and adversarial_snapshot_matches
            )

            if decision == "APPROVE" and not eligible:
                rejection = (
                    409,
                    {
                        "message": "Approval blocked. Required technical review gates have not passed.",
                        "gates": gates,
                    },
                )
            else:
                # Final consistency check immediately before the write.
                confirm_evidence, confirm_snapshot_data = evidence_state(
                    db, commitment_id
                )
                confirm_snapshot = _snapshot_hash(confirm_snapshot_data)

                if decision == "APPROVE" and (
                    confirm_snapshot != current_snapshot
                    or any(
                        item["integrity"] != "PASS"
                        for item in confirm_evidence
                    )
                ):
                    rejection = (
                        409,
                        {
                            "message": "Evidence changed during approval. Retry after reviews are refreshed.",
                            "gates": gates,
                        },
                    )
                else:
                    approval_id = "APR-" + uuid.uuid4().hex[:12].upper()

                    db.execute(
                        """INSERT INTO approval_history
                        VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (
                            approval_id,
                            commitment_id,
                            payload.approver_id,
                            decision,
                            payload.reason,
                            json.dumps(gates),
                            created_at,
                        )
                    )

                    db.execute(
                        "UPDATE commitments SET status = ? WHERE id = ?",
                        (
                            "APPROVED"
                            if decision == "APPROVE"
                            else "REJECTED",
                            commitment_id,
                        )
                    )

                    audit_row(
                        db,
                        commitment_id,
                        "HUMAN_APPROVAL_DECISION",
                        {
                            "approval_id": approval_id,
                            "approver_id": payload.approver_id,
                            "decision": decision,
                            "reason": payload.reason,
                            "gates": gates,
                        },
                        principal=principal,
                        created_at=created_at,
                    )

                    db.commit()

    if rejection is not None:
        raise HTTPException(rejection[0], rejection[1])

    return {
        "approval_id": approval_id,
        "commitment_id": commitment_id,
        "approver_id": payload.approver_id,
        "decision": decision,
        "status": "APPROVED" if decision == "APPROVE" else "REJECTED",
        "gates": gates,
        "created_at": created_at
    }


@app.get("/commitments/{commitment_id}/approval-history")
def get_approval_history(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):
    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

        rows = db.execute(
            """SELECT * FROM approval_history
            WHERE commitment_id = ?
            ORDER BY created_at DESC, rowid DESC""",
            (commitment_id,)
        ).fetchall()

    return [
        {
            **dict(row),
            "gate_snapshot": json.loads(row["gate_snapshot"])
        }
        for row in rows
    ]


@app.post("/commitments/{commitment_id}/reopen")
def reopen_commitment(
    commitment_id: str,
    payload: ReopenInput,
    principal: dict = Depends(require_roles("owner")),
):
    """Explicitly reopen an APPROVED commitment for further evidence/review."""
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")

        commitment = db.execute(
            "SELECT id, status, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_write(principal, commitment)

        if commitment["status"] != "APPROVED":
            raise HTTPException(
                409,
                "Only APPROVED commitments can be reopened.",
            )

        db.execute(
            "UPDATE commitments SET status = ? WHERE id = ?",
            ("REOPENED", commitment_id)
        )

        audit_row(
            db,
            commitment_id,
            "COMMITMENT_REOPENED",
            {
                "previous_status": "APPROVED",
                "new_status": "REOPENED",
                "reason": payload.reason,
            },
            principal=principal,
        )

    return {
        "commitment_id": commitment_id,
        "status": "REOPENED",
        "message": "Commitment reopened. New evidence and fresh reviews are required.",
    }


# ============================================================
# PACTORA TRUST COLLAPSE ENGINE
# Detects evidence changes and invalidates affected commitments.
# ============================================================

def inspect_commitment_evidence_with_db(db, commitment_id):
    results, _ = evidence_state(db, commitment_id)
    return results


def inspect_commitment_evidence(commitment_id: str):
    with connect() as db:
        return inspect_commitment_evidence_with_db(db, commitment_id)


def _collect_affected_commitments(db, commitment_id):
    queue = [commitment_id]
    visited = set()
    affected = []

    while queue:
        current_id = queue.pop(0)

        if current_id in visited:
            continue

        visited.add(current_id)

        row = db.execute(
            "SELECT status FROM commitments WHERE id = ?",
            (current_id,)
        ).fetchone()

        if not row:
            continue

        affected.append(current_id)

        dependents = db.execute(
            "SELECT commitment_id FROM commitment_dependencies WHERE depends_on_id = ?",
            (current_id,)
        ).fetchall()

        queue.extend(item["commitment_id"] for item in dependents)

    return affected


def validate_reachable_dependencies(db, commitment_id):
    """Reject malformed legacy edges instead of silently skipping them."""
    issues = []
    queue = [commitment_id]
    visited = set()

    while queue:
        current_id = queue.pop(0)

        if current_id in visited:
            continue

        visited.add(current_id)

        row = db.execute(
            "SELECT id FROM commitments WHERE id = ?",
            (current_id,)
        ).fetchone()

        if not row:
            issues.append({
                "type": "MISSING_COMMITMENT",
                "commitment_id": current_id,
            })
            continue

        dependents = db.execute(
            """SELECT id, commitment_id, depends_on_id
            FROM commitment_dependencies
            WHERE depends_on_id = ?""",
            (current_id,)
        ).fetchall()

        for edge in dependents:
            if edge["commitment_id"] == edge["depends_on_id"]:
                issues.append({
                    "type": "SELF_DEPENDENCY",
                    "dependency_id": edge["id"],
                })

            child = db.execute(
                "SELECT id FROM commitments WHERE id = ?",
                (edge["commitment_id"],)
            ).fetchone()

            if not child:
                issues.append({
                    "type": "MISSING_DEPENDENT",
                    "dependency_id": edge["id"],
                    "commitment_id": edge["commitment_id"],
                })
                continue

            queue.append(edge["commitment_id"])

    return issues


def propagate_trust_collapse_with_db(
    db,
    commitment_id,
    failed_evidence,
    affected,
    principal=None,
    scan_reason="",
):
    for current_id in affected:
        row = db.execute(
            "SELECT status FROM commitments WHERE id = ?",
            (current_id,)
        ).fetchone()

        if not row:
            continue

        previous_status = row["status"]

        if previous_status == "INVALIDATED":
            continue

        db.execute(
            "UPDATE commitments SET status = ? WHERE id = ?",
            ("INVALIDATED", current_id)
        )

        audit_row(
            db,
            current_id,
            "TRUST_COLLAPSE_DETECTED",
            {
                "reason": "Evidence integrity failure or dependency trust collapse.",
                "root_commitment_id": commitment_id,
                "previous_status": previous_status,
                "new_status": "INVALIDATED",
                "affected_evidence": (
                    failed_evidence if current_id == commitment_id else []
                ),
                "scan_reason": scan_reason,
            },
            principal=principal,
        )


def _trust_scan_plan(db, commitment_id):
    commitment = db.execute(
        "SELECT id, status FROM commitments WHERE id = ?",
        (commitment_id,)
    ).fetchone()

    if not commitment:
        raise HTTPException(404, "Commitment not found.")

    results, _ = evidence_state(db, commitment_id)

    if not results:
        raise HTTPException(400, "No evidence attached to this commitment.")

    failed = [item for item in results if item["integrity"] == "FAILED"]
    all_pass = len(failed) == 0

    affected = []
    issues = []

    if not all_pass:
        issues = validate_reachable_dependencies(db, commitment_id)
        if not issues:
            affected = _collect_affected_commitments(db, commitment_id)

    return commitment, results, failed, all_pass, affected, issues


@app.post("/commitments/{commitment_id}/trust-scan")
def trust_scan(
    commitment_id: str,
    dry_run: bool = Query(default=False),
    scan_reason: str = Header(default="", alias="X-Scan-Reason"),
    principal: dict = Depends(require_roles("service")),
):

    if dry_run:
        with connect() as db:
            (
                commitment,
                results,
                failed,
                all_pass,
                affected,
                issues,
            ) = _trust_scan_plan(db, commitment_id)

        if issues:
            raise HTTPException(
                409,
                {
                    "message": "Dependency graph validation failed.",
                    "issues": issues,
                },
            )

        return {
            "commitment_id": commitment_id,
            "trust_status": "INTACT" if all_pass else "COLLAPSED",
            "commitment_status": (
                commitment["status"] if all_pass else "INVALIDATED"
            ),
            "evidence_count": len(results),
            "failed_evidence_count": len(failed),
            "affected_commitments": affected,
            "would_invalidate": affected,
            "dry_run": True,
            "results": results,
            "claim_semantically_verified": False,
            "message": (
                "Dry run: all evidence fingerprints match."
                if all_pass
                else "Dry run: evidence integrity failure would invalidate the listed commitments."
            ),
        }

    with connect() as db:
        db.execute("BEGIN IMMEDIATE")

        (
            commitment,
            results,
            failed,
            all_pass,
            affected_commitments,
            issues,
        ) = _trust_scan_plan(db, commitment_id)

        if issues:
            raise HTTPException(
                409,
                {
                    "message": "Dependency graph validation failed.",
                    "issues": issues,
                },
            )

        if not all_pass:
            propagate_trust_collapse_with_db(
                db,
                commitment_id,
                failed,
                affected_commitments,
                principal=principal,
                scan_reason=scan_reason,
            )

    return {
        "commitment_id": commitment_id,
        "trust_status": "INTACT" if all_pass else "COLLAPSED",
        "commitment_status": (
            commitment["status"] if all_pass else "INVALIDATED"
        ),
        "evidence_count": len(results),
        "failed_evidence_count": len(failed),
        "affected_commitments": affected_commitments,
        "dry_run": False,
        "results": results,
        "claim_semantically_verified": False,
        "message": (
            "All evidence fingerprints match. No integrity changes detected."
            if all_pass
            else "Evidence integrity failure detected. Commitment invalidated."
        ),
    }

# ============================================================
# PACTORA TRUST PASSPORT
# Generates a transparent snapshot of commitment assurance.
# ============================================================

@app.get("/commitments/{commitment_id}/trust-passport")
def generate_trust_passport(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):

    with connect() as db:
        commitment = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

        evidence_rows = db.execute(
            "SELECT * FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

        check_rows = db.execute(
            """SELECT * FROM proof_checks
            WHERE commitment_id = ? ORDER BY created_at ASC""",
            (commitment_id,)
        ).fetchall()

        proof_rows = db.execute(
            """SELECT * FROM proof_evaluations
            WHERE commitment_id = ?
            ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

        verification_rows = db.execute(
            """SELECT * FROM verification_reviews
            WHERE commitment_id = ?
            ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

        adversarial_rows = db.execute(
            """SELECT * FROM adversarial_reviews
            WHERE commitment_id = ?
            ORDER BY created_at DESC""",
            (commitment_id,)
        ).fetchall()

        approval_rows = db.execute(
            """SELECT * FROM approval_history
            WHERE commitment_id = ?
            ORDER BY created_at DESC, rowid DESC""",
            (commitment_id,)
        ).fetchall()

        audit_rows = db.execute(
            """SELECT * FROM audit_events
            WHERE commitment_id = ?
            ORDER BY created_at ASC, rowid ASC""",
            (commitment_id,)
        ).fetchall()

    evidence = []

    for row in evidence_rows:
        path = Path(row["stored_path"])
        exists = path.is_file()

        actual_hash = (
            hashlib.sha256(path.read_bytes()).hexdigest()
            if exists else None
        )

        integrity = (
            "PASS" if exists and actual_hash == row["sha256"]
            else "FAILED"
        )

        evidence.append({
            "evidence_id": row["id"],
            "filename": row["filename"],
            "sha256": row["sha256"],
            "created_at": row["created_at"],
            "file_exists": exists,
            "current_sha256": actual_hash,
            "integrity": integrity
        })

    proof_checks = [dict(row) for row in check_rows]

    proof_history = [
        {
            "evaluation_id": row["id"],
            "result": row["result"],
            "details": json.loads(row["details"]),
            "created_at": row["created_at"]
        }
        for row in proof_rows
    ]

    verification_history = [
        {
            "review_id": row["id"],
            "result": row["result"],
            "reviewer_type": row["reviewer_type"],
            "details": json.loads(row["details"]),
            "created_at": row["created_at"]
        }
        for row in verification_rows
    ]

    adversarial_history = [
        {
            "review_id": row["id"],
            "result": row["result"],
            "findings": json.loads(row["findings"]),
            "created_at": row["created_at"]
        }
        for row in adversarial_rows
    ]

    approval_history = [
        {
            **dict(row),
            "gate_snapshot": json.loads(row["gate_snapshot"])
        }
        for row in approval_rows
    ]

    audit_trail = [
        {
            **dict(row),
            "details": json.loads(row["details"])
        }
        for row in audit_rows
    ]

    integrity_state = (
        "NOT_AVAILABLE" if not evidence
        else "INTACT" if all(
            item["integrity"] == "PASS" for item in evidence
        )
        else "COLLAPSED"
    )

    latest_proof = proof_history[0] if proof_history else None
    latest_verification = (
        verification_history[0] if verification_history else None
    )
    latest_adversarial = (
        adversarial_history[0] if adversarial_history else None
    )
    latest_approval = (
        approval_history[0] if approval_history else None
    )

    limitations = [
        "Configured deterministic checks do not establish complete business-claim truth.",
        "Independent verification is a deterministic recheck, not an independent human audit.",
        "Adversarial review uses heuristic rules, not autonomous AI reasoning.",
        "Evidence SHA-256 fingerprints detect file changes but do not prove evidence authenticity.",
        "This passport is an unsigned snapshot and is not a cryptographically signed credential."
    ]

    if not evidence:
        limitations.append("No evidence is attached.")

    if integrity_state == "COLLAPSED":
        limitations.append(
            "One or more evidence files are missing or have changed."
        )

    return {
        "passport_id": "PAS-" + uuid.uuid4().hex[:12].upper(),
        "generated_at": now(),
        "passport_type": "PACTORA_COMMITMENT_ASSURANCE_SNAPSHOT",

        "commitment": dict(commitment),

        "evidence": evidence,

        "proof": {
            "configured_checks": proof_checks,
            "history": proof_history,
            "latest_result": (
                latest_proof["result"] if latest_proof else None
            )
        },

        "verification": {
            "history": verification_history,
            "latest_result": (
                latest_verification["result"]
                if latest_verification else None
            ),
            "method": "DETERMINISTIC_RECHECK"
        },

        "adversarial": {
            "history": adversarial_history,
            "latest_result": (
                latest_adversarial["result"]
                if latest_adversarial else None
            ),
            "method": "HEURISTIC_REVIEW"
        },

        "approval": {
            "history": approval_history,
            "latest_decision": (
                latest_approval["decision"]
                if latest_approval else None
            ),
            "approver_id": (
                latest_approval["approver_id"]
                if latest_approval else None
            )
        },

        "audit_trail": audit_trail,

        "trust_summary": {
            "commitment_status": commitment["status"],
            "evidence_integrity": integrity_state,
            "proof_state": (
                latest_proof["result"] if latest_proof else "NOT_RUN"
            ),
            "independent_review_state": (
                latest_verification["result"]
                if latest_verification else "NOT_RUN"
            ),
            "adversarial_review_state": (
                latest_adversarial["result"]
                if latest_adversarial else "NOT_RUN"
            ),
            "human_approval_state": (
                latest_approval["decision"]
                if latest_approval else "PENDING"
            ),
            "claim_semantically_verified": False,
            "limitations": limitations
        },

        "claim_semantically_verified": False
    }


# ============================================================
# PACTORA TRUST GRAPH DATABASE
# Stores explicit commitment dependencies.
# Other graph relationships are derived from existing records.
# ============================================================

def initialize_trust_graph_tables():
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS commitment_dependencies (
                id TEXT PRIMARY KEY,
                commitment_id TEXT NOT NULL,
                depends_on_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(commitment_id, depends_on_id),
                FOREIGN KEY(commitment_id) REFERENCES commitments(id),
                FOREIGN KEY(depends_on_id) REFERENCES commitments(id)
            )
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_dependencies_commitment
            ON commitment_dependencies(commitment_id)
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_dependencies_target
            ON commitment_dependencies(depends_on_id)
        """)



# ============================================================
# PACTORA TRUST GRAPH API
# A dependency means the first commitment requires the second.
# ============================================================

@app.post("/commitments/{commitment_id}/dependencies")
def create_commitment_dependency(
    commitment_id: str,
    payload: dict,
    principal: dict = Depends(require_roles("owner")),
):
    depends_on_id = payload.get("depends_on_id")

    if not isinstance(depends_on_id, str) or not depends_on_id.strip():
        raise HTTPException(400, "depends_on_id is required.")

    depends_on_id = depends_on_id.strip()

    if commitment_id == depends_on_id:
        raise HTTPException(400, "A commitment cannot depend on itself.")

    with connect() as db:
        db.execute("BEGIN IMMEDIATE")

        dependent = db.execute(
            "SELECT id, status, owner FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        prerequisite = db.execute(
            "SELECT id, status FROM commitments WHERE id = ?",
            (depends_on_id,)
        ).fetchone()

        if not dependent or not prerequisite:
            raise HTTPException(404, "One or both commitments were not found.")

        _require_write(principal, dependent)

        if dependent["status"] == "APPROVED":
            raise HTTPException(
                409,
                "Approved commitments must be reopened before dependency changes.",
            )

        if dependent["status"] == "INVALIDATED":
            raise HTTPException(
                409,
                "Invalidated commitments must be re-attested before dependency changes.",
            )

        if prerequisite["status"] == "INVALIDATED":
            raise HTTPException(
                409,
                "A commitment cannot depend on an invalidated commitment.",
            )

        existing = db.execute(
            """SELECT id FROM commitment_dependencies
               WHERE commitment_id = ? AND depends_on_id = ?""",
            (commitment_id, depends_on_id)
        ).fetchone()

        if existing:
            raise HTTPException(409, "This dependency already exists.")

        cycle = db.execute(
            """
            WITH RECURSIVE reachable(id) AS (
                SELECT depends_on_id
                FROM commitment_dependencies
                WHERE commitment_id = ?
                UNION
                SELECT d.depends_on_id
                FROM commitment_dependencies d
                JOIN reachable r ON d.commitment_id = r.id
            )
            SELECT 1 FROM reachable WHERE id = ? LIMIT 1
            """,
            (depends_on_id, commitment_id)
        ).fetchone()

        if cycle:
            raise HTTPException(409, "Dependency would create a circular relationship.")

        dependency_id = "DEP-" + uuid.uuid4().hex[:12].upper()
        created_at = now()

        db.execute(
            """INSERT INTO commitment_dependencies
               (id, commitment_id, depends_on_id, created_at)
               VALUES (?, ?, ?, ?)""",
            (dependency_id, commitment_id, depends_on_id, created_at)
        )

        audit_row(
            db,
            commitment_id,
            "DEPENDENCY_CREATED",
            {
                "dependency_id": dependency_id,
                "depends_on_id": depends_on_id,
            },
            principal=principal,
            created_at=created_at,
        )

    return {
        "dependency_id": dependency_id,
        "commitment_id": commitment_id,
        "depends_on_id": depends_on_id,
        "relationship": "DEPENDS_ON",
        "created_at": created_at
    }


@app.get("/commitments/{commitment_id}/trust-graph")
def get_commitment_trust_graph(
    commitment_id: str,
    principal: dict = Depends(authenticate_request),
):
    with connect() as db:
        commitment = db.execute(
            "SELECT * FROM commitments WHERE id = ?",
            (commitment_id,)
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_read(principal, commitment)

        dependencies = db.execute(
            """SELECT * FROM commitment_dependencies
               WHERE commitment_id = ? OR depends_on_id = ?""",
            (commitment_id, commitment_id)
        ).fetchall()

        evidence = db.execute(
            "SELECT id, commitment_id, filename, sha256 FROM evidence WHERE commitment_id = ?",
            (commitment_id,)
        ).fetchall()

    nodes = [{
        "id": commitment["id"],
        "type": "COMMITMENT",
        "title": commitment["title"],
        "status": commitment["status"]
    }]

    edges = []

    for item in evidence:
        nodes.append({
            "id": item["id"],
            "type": "EVIDENCE",
            "filename": item["filename"],
            "sha256": item["sha256"]
        })
        edges.append({
            "source": commitment_id,
            "target": item["id"],
            "type": "SUPPORTED_BY"
        })

    related_ids = set()

    for item in dependencies:
        related_ids.add(item["commitment_id"])
        related_ids.add(item["depends_on_id"])
        edges.append({
            "source": item["commitment_id"],
            "target": item["depends_on_id"],
            "type": "DEPENDS_ON"
        })

    related_ids.discard(commitment_id)

    if related_ids:
        placeholders = ",".join("?" for _ in related_ids)
        with connect() as db:
            rows = db.execute(
                f"SELECT id, title, status FROM commitments WHERE id IN ({placeholders})",
                tuple(related_ids)
            ).fetchall()

        for row in rows:
            nodes.append({
                "id": row["id"],
                "type": "COMMITMENT",
                "title": row["title"],
                "status": row["status"]
            })

    return {"nodes": nodes, "edges": edges}


@app.get("/trust-graph")
def get_global_trust_graph(
    principal: dict = Depends(authenticate_request),
):
    with connect() as db:
        commitments = db.execute(
            "SELECT id, title, status, owner FROM commitments"
        ).fetchall()

        evidence = db.execute(
            "SELECT id, commitment_id, filename, sha256 FROM evidence"
        ).fetchall()

        dependencies = db.execute(
            "SELECT id, commitment_id, depends_on_id FROM commitment_dependencies"
        ).fetchall()

    nodes = []
    edges = []

    for item in commitments:
        nodes.append({
            "id": item["id"],
            "type": "COMMITMENT",
            "title": item["title"],
            "status": item["status"]
        })

        owner_id = "OWNER-" + item["owner"]
        if not any(node["id"] == owner_id for node in nodes):
            nodes.append({
                "id": owner_id,
                "type": "OWNER",
                "name": item["owner"]
            })

        edges.append({
            "source": owner_id,
            "target": item["id"],
            "type": "OWNS"
        })

    for item in evidence:
        nodes.append({
            "id": item["id"],
            "type": "EVIDENCE",
            "filename": item["filename"],
            "sha256": item["sha256"]
        })
        edges.append({
            "source": item["commitment_id"],
            "target": item["id"],
            "type": "SUPPORTED_BY"
        })

    for item in dependencies:
        edges.append({
            "source": item["commitment_id"],
            "target": item["depends_on_id"],
            "type": "DEPENDS_ON"
        })

    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": nodes,
        "edges": edges
    }


# ============================================================
# PACTORA DEMO EXERCISES
# Real, explicit evidence mutation for the guided demonstration.
# Disabled unless PACTORA_DEMO_MODE is enabled.
# ============================================================

def _demo_mode_enabled():
    return os.getenv("PACTORA_DEMO_MODE", "").strip().lower() in {
        "1", "true", "yes", "on"
    }


@app.post("/demo/commitments/{commitment_id}/tamper")
def demo_tamper_evidence(
    commitment_id: str,
    principal: dict = Depends(require_roles("owner")),
):
    if not _demo_mode_enabled():
        raise HTTPException(404, "Demo exercises are disabled.")

    with connect() as db:
        commitment = db.execute(
            "SELECT id, owner FROM commitments WHERE id = ?",
            (commitment_id,),
        ).fetchone()

        if not commitment:
            raise HTTPException(404, "Commitment not found.")

        _require_write(principal, commitment)

        evidence = db.execute(
            """SELECT * FROM evidence
            WHERE commitment_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1""",
            (commitment_id,),
        ).fetchone()

    if not evidence:
        raise HTTPException(400, "No evidence attached to this commitment.")

    path = Path(evidence["stored_path"])

    if not path.is_file():
        raise HTTPException(409, "Evidence file is missing; it cannot be tampered with.")

    before = hashlib.sha256(path.read_bytes()).hexdigest()
    marker = (
        "\n[PACTORA DEMO EXERCISE] storage_encryption=false "
        + datetime.now(timezone.utc).isoformat()
    )

    with path.open("ab") as handle:
        handle.write(marker.encode("utf-8"))

    after = hashlib.sha256(path.read_bytes()).hexdigest()

    audit(commitment_id, "DEMO_EVIDENCE_TAMPERED", {
        "evidence_id": evidence["id"],
        "before_sha256": before,
        "after_sha256": after,
        "scope": "LOCAL_DEMO_EXERCISE",
    }, principal=principal)

    return {
        "commitment_id": commitment_id,
        "evidence_id": evidence["id"],
        "before_sha256": before,
        "after_sha256": after,
        "message": (
            "Local demo exercise only. The stored evidence file was modified. "
            "Run a sentinel trust scan to observe the trust collapse."
        ),
    }


# ============================================================
# PACTORA AGENT OVERVIEW
# Deterministic reports derived from live records, not fabricated.
# ============================================================

def _latest_row(db, query, params=()):
    return db.execute(query, params).fetchone()


@app.get("/agents/overview")
def agents_overview(principal: dict = Depends(authenticate_request)):
    generated_at = now()

    with connect() as db:
        commitments = db.execute(
            "SELECT * FROM commitments ORDER BY created_at DESC"
        ).fetchall()

        latest_verification = _latest_row(
            db,
            """SELECT v.*, c.title AS commitment_title
               FROM verification_reviews v
               JOIN commitments c ON c.id = v.commitment_id
               ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1""",
        )

        latest_adversarial = _latest_row(
            db,
            """SELECT a.*, c.title AS commitment_title
               FROM adversarial_reviews a
               JOIN commitments c ON c.id = a.commitment_id
               ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1""",
        )

        latest_collapse = _latest_row(
            db,
            """SELECT a.*, c.title AS commitment_title
               FROM audit_events a
               JOIN commitments c ON c.id = a.commitment_id
               WHERE a.event_type = 'TRUST_COLLAPSE_DETECTED'
               ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1""",
        )

    integrity_failures = []
    missing_proof = []
    status_counts = {}

    for commitment in commitments:
        status_counts[commitment["status"]] = (
            status_counts.get(commitment["status"], 0) + 1
        )

        for item in inspect_commitment_evidence(commitment["id"]):
            if item["integrity"] != "PASS":
                integrity_failures.append({
                    "commitment_id": commitment["id"],
                    "commitment_title": commitment["title"],
                    "evidence_id": item["evidence_id"],
                    "filename": item["filename"],
                    "reason": item["reason"],
                })

        if commitment["status"] == "UNDER_REVIEW":
            with connect() as db:
                proof = db.execute(
                    """SELECT id FROM proof_evaluations
                       WHERE commitment_id = ? AND result = 'PASS'
                       LIMIT 1""",
                    (commitment["id"],),
                ).fetchone()
            if not proof:
                missing_proof.append({
                    "commitment_id": commitment["id"],
                    "commitment_title": commitment["title"],
                })

    invalidated = [
        item for item in commitments
        if item["status"] == "INVALIDATED"
    ]

    oracle_findings = []

    for item in invalidated:
        oracle_findings.append({
            "severity": "CRITICAL",
            "code": "COMMITMENT_INVALIDATED",
            "message": (
                f"{item['title']} ({item['id']}) is invalidated and cannot be "
                "approved or extended with new evidence."
            ),
        })

    for item in integrity_failures:
        oracle_findings.append({
            "severity": "CRITICAL",
            "code": "EVIDENCE_INTEGRITY_FAILURE",
            "message": (
                f"{item['filename']} for {item['commitment_title']} fails "
                "fingerprint verification."
            ),
        })

    for item in missing_proof:
        oracle_findings.append({
            "severity": "WARNING",
            "code": "PROOF_NOT_PASSED",
            "message": (
                f"{item['commitment_title']} is under review without a passing "
                "deterministic proof evaluation."
            ),
        })

    oracle_recommendations = []

    if invalidated or integrity_failures:
        oracle_recommendations.append(
            "Freeze dependent commitments and begin a re-attestation review."
        )

    if missing_proof:
        oracle_recommendations.append(
            "Configure deterministic acceptance checks and evaluate them before approval."
        )

    if not oracle_recommendations:
        oracle_recommendations.append(
            "Continue monitoring evidence fingerprints and review freshness."
        )

    verifier_findings = []
    verifier_recommendations = []

    if latest_verification:
        details = json.loads(latest_verification["details"])
        for result in details.get("results", []):
            if result.get("outcome") != "PASS":
                verifier_findings.append({
                    "severity": "WARNING",
                    "code": "INDEPENDENT_CHECK_NOT_PASSED",
                    "message": (
                        f"Check {result.get('check_id')} returned "
                        f"{result.get('outcome')} for evidence "
                        f"{result.get('evidence_id')}."
                    ),
                })
        verifier_recommendations.append(
            "Refresh independent verification whenever evidence changes."
        )
    else:
        verifier_findings.append({
            "severity": "INFO",
            "code": "NO_INDEPENDENT_REVIEW",
            "message": "No independent review has been recorded yet.",
        })
        verifier_recommendations.append(
            "Configure proof checks, then run an independent review."
        )

    adversarial_findings = []

    if latest_adversarial:
        adversarial_findings = json.loads(latest_adversarial["findings"])
    else:
        adversarial_findings = [{
            "severity": "INFO",
            "code": "NO_ADVERSARIAL_REVIEW",
            "message": "No adversarial review has been recorded yet.",
        }]

    adversarial_recommendations = [
        "Add corroborating evidence to address single-source findings.",
        "Record the remaining semantic limitations in the Trust Passport.",
    ]

    sentinel_findings = []

    for item in integrity_failures:
        sentinel_findings.append({
            "severity": "CRITICAL",
            "code": "FINGERPRINT_MISMATCH",
            "message": (
                f"{item['filename']} ({item['evidence_id']}) no longer matches "
                "its recorded SHA-256 fingerprint."
            ),
        })

    if not sentinel_findings:
        sentinel_findings.append({
            "severity": "INFO",
            "code": "NO_INTEGRITY_CHANGES",
            "message": "All currently known evidence fingerprints match stored records.",
        })

    sentinel_recommendations = [
        "Run a trust scan after any storage migration or configuration change.",
        "Dependent commitments inherit invalidation from a failed prerequisite.",
    ]

    agents = [
        {
            "id": "ORACLE",
            "name": "ORACLE",
            "role": "Business intelligence and risk analysis",
            "status": "ATTENTION" if oracle_findings else "READY",
            "last_report": {
                "report_type": "LIVE_PORTFOLIO_SYNTHESIS",
                "generated_at": generated_at,
                "summary": (
                    f"{len(commitments)} commitments observed. "
                    f"{len(invalidated)} invalidated. "
                    f"{len(integrity_failures)} evidence integrity failures. "
                    f"{len(missing_proof)} under-review commitments without a passing proof."
                ),
                "findings": oracle_findings,
                "recommendations": oracle_recommendations,
            },
            "metrics": {
                "commitments": len(commitments),
                "status_counts": status_counts,
            },
        },
        {
            "id": "VERIFIER",
            "name": "VERIFIER",
            "role": "Independent evidence integrity verification",
            "status": (
                "ATTENTION"
                if latest_verification and latest_verification["result"] != "PASS"
                else "READY"
            ),
            "last_report": {
                "review_id": latest_verification["id"] if latest_verification else None,
                "commitment_id": (
                    latest_verification["commitment_id"]
                    if latest_verification else None
                ),
                "commitment_title": (
                    latest_verification["commitment_title"]
                    if latest_verification else None
                ),
                "generated_at": (
                    latest_verification["created_at"]
                    if latest_verification else generated_at
                ),
                "summary": (
                    f"Latest independent review result: {latest_verification['result']}."
                    if latest_verification else "No independent review has been run."
                ),
                "findings": verifier_findings,
                "recommendations": verifier_recommendations,
            },
            "metrics": {
                "latest_result": (
                    latest_verification["result"]
                    if latest_verification else None
                ),
            },
        },
        {
            "id": "ADVERSARY",
            "name": "ADVERSARY",
            "role": "Adversarial review and weakness discovery",
            "status": (
                "ATTENTION"
                if latest_adversarial and latest_adversarial["result"] == "CHALLENGED"
                else "READY"
            ),
            "last_report": {
                "review_id": latest_adversarial["id"] if latest_adversarial else None,
                "commitment_id": (
                    latest_adversarial["commitment_id"]
                    if latest_adversarial else None
                ),
                "commitment_title": (
                    latest_adversarial["commitment_title"]
                    if latest_adversarial else None
                ),
                "generated_at": (
                    latest_adversarial["created_at"]
                    if latest_adversarial else generated_at
                ),
                "summary": (
                    f"Latest adversarial review result: {latest_adversarial['result']}."
                    if latest_adversarial else "No adversarial review has been run."
                ),
                "findings": adversarial_findings,
                "recommendations": adversarial_recommendations,
            },
            "metrics": {
                "latest_result": (
                    latest_adversarial["result"]
                    if latest_adversarial else None
                ),
            },
        },
        {
            "id": "SENTINEL",
            "name": "SENTINEL",
            "role": "Integrity monitoring and trust-state monitoring",
            "status": "ATTENTION" if integrity_failures else "MONITORING",
            "last_report": {
                "last_collapse_event_id": (
                    latest_collapse["id"] if latest_collapse else None
                ),
                "commitment_id": (
                    latest_collapse["commitment_id"]
                    if latest_collapse else None
                ),
                "commitment_title": (
                    latest_collapse["commitment_title"]
                    if latest_collapse else None
                ),
                "generated_at": generated_at,
                "summary": (
                    f"{len(integrity_failures)} evidence integrity failures detected "
                    "across the current portfolio."
                ),
                "findings": sentinel_findings,
                "recommendations": sentinel_recommendations,
            },
            "metrics": {
                "evidence_failures": len(integrity_failures),
                "latest_collapse_event": (
                    latest_collapse["id"] if latest_collapse else None
                ),
            },
        },
    ]

    return {
        "generated_at": generated_at,
        "commitments_observed": len(commitments),
        "agents": agents,
    }
