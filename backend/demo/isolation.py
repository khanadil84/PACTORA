"""Guarded, non-destructive state management for the Guided Demonstration.

The production application resolves its database and evidence directory at
import time in ``backend.app.main``.  This module never edits that module or
its configuration.  Instead it prepares a separate state directory and the
launcher rebinds the module globals for the lifetime of the isolated process.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Dict


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
PRODUCTION_DATA_DIR = BACKEND_DIR / "data"
PRODUCTION_EVIDENCE_DIR = BACKEND_DIR / "evidence"
PRODUCTION_DB = PRODUCTION_DATA_DIR / "pactora.db"

DEFAULT_STATE_DIR = REPO_ROOT / "runtime-demo" / "guided-demo"


class IsolationError(RuntimeError):
    """Raised when a path would touch production data or evidence."""


@dataclass(frozen=True)
class IsolationPaths:
    state_dir: Path
    data_dir: Path
    db_path: Path
    evidence_dir: Path

    def as_dict(self) -> Dict[str, str]:
        return {
            "state_dir": str(self.state_dir),
            "data_dir": str(self.data_dir),
            "db_path": str(self.db_path),
            "evidence_dir": str(self.evidence_dir),
        }


def _norm(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _same_path(left: Path, right: Path) -> bool:
    return _norm(left) == _norm(right)


def _is_relative_to(child: Path, parent: Path) -> bool:
    child_norm = Path(_norm(child))
    parent_norm = Path(_norm(parent))

    try:
        child_norm.relative_to(parent_norm)
    except ValueError:
        return False

    return True


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def snapshot_production() -> dict:
    """Return fingerprints for the original database and evidence files."""
    evidence = {}

    if PRODUCTION_EVIDENCE_DIR.is_dir():
        for path in sorted(PRODUCTION_EVIDENCE_DIR.rglob("*")):
            if path.is_file():
                evidence[str(path.relative_to(PRODUCTION_EVIDENCE_DIR))] = (
                    sha256_file(path)
                )

    return {
        "db_path": str(PRODUCTION_DB),
        "db_exists": PRODUCTION_DB.is_file(),
        "db_sha256": (
            sha256_file(PRODUCTION_DB) if PRODUCTION_DB.is_file() else None
        ),
        "evidence_dir": str(PRODUCTION_EVIDENCE_DIR),
        "evidence": evidence,
    }


def assert_production_unchanged(before: dict) -> None:
    after = snapshot_production()

    if before != after:
        raise IsolationError(
            "Production data changed during the isolated demonstration.\n"
            f"Before: {before}\nAfter:  {after}"
        )


def _validate_state_dir(state_dir: Path) -> None:
    resolved = state_dir.resolve()

    if resolved.exists() and not resolved.is_dir():
        raise IsolationError(f"State path is not a directory: {resolved}")

    if _same_path(resolved, REPO_ROOT) or _same_path(resolved, BACKEND_DIR):
        raise IsolationError(
            f"Refusing to use {resolved} as demo state; use a dedicated directory."
        )

    if _same_path(resolved, PRODUCTION_DATA_DIR) or _same_path(
        resolved, PRODUCTION_EVIDENCE_DIR
    ):
        raise IsolationError(
            f"Refusing to use production path as demo state: {resolved}"
        )

    if _is_relative_to(resolved, PRODUCTION_DATA_DIR) or _is_relative_to(
        resolved, PRODUCTION_EVIDENCE_DIR
    ):
        raise IsolationError(
            f"Refusing to place demo state inside production data: {resolved}"
        )


def prepare_state(state_dir: Path, reset: bool = False) -> IsolationPaths:
    """Create (or reset) an isolated database and evidence directory."""
    state_dir = Path(state_dir).resolve()
    _validate_state_dir(state_dir)

    if reset and state_dir.exists():
        shutil.rmtree(state_dir)

    paths = IsolationPaths(
        state_dir=state_dir,
        data_dir=state_dir / "data",
        db_path=state_dir / "data" / "pactora.db",
        evidence_dir=state_dir / "evidence",
    )

    if _same_path(paths.db_path, PRODUCTION_DB):
        raise IsolationError("Isolated database resolved to the production DB.")

    if _same_path(paths.evidence_dir, PRODUCTION_EVIDENCE_DIR):
        raise IsolationError(
            "Isolated evidence resolved to the production evidence directory."
        )

    paths.data_dir.mkdir(parents=True, exist_ok=True)
    paths.evidence_dir.mkdir(parents=True, exist_ok=True)

    return paths


def install_isolated_paths(main_module, paths: IsolationPaths) -> None:
    """Rebind the already-imported application module to isolated paths.

    ``main.connect()`` and evidence storage read these module globals on every
    request, so no application file or configuration needs to change.
    """
    db_path = Path(paths.db_path).resolve()
    evidence_dir = Path(paths.evidence_dir).resolve()

    if _same_path(db_path, PRODUCTION_DB):
        raise IsolationError("Refusing to bind the production database.")

    if _same_path(evidence_dir, PRODUCTION_EVIDENCE_DIR):
        raise IsolationError("Refusing to bind the production evidence directory.")

    main_module.DATA_DIR = Path(paths.data_dir).resolve()
    main_module.DB_PATH = db_path
    main_module.EVIDENCE_DIR = evidence_dir


def assert_bound(main_module, paths: IsolationPaths) -> None:
    if not _same_path(main_module.DB_PATH, paths.db_path):
        raise IsolationError(
            f"Application DB_PATH is not isolated: {main_module.DB_PATH}"
        )

    if not _same_path(main_module.EVIDENCE_DIR, paths.evidence_dir):
        raise IsolationError(
            "Application EVIDENCE_DIR is not isolated: "
            f"{main_module.EVIDENCE_DIR}"
        )
