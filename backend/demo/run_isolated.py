"""Launch PACTORA's Guided Demonstration against isolated demo state.

This process:
  * creates a dedicated SQLite database and evidence directory;
  * rebinds ``backend.app.main`` module globals at runtime;
  * never edits ``backend/.env``, ``main.py`` or the production database.

Run from the repository root:

    python -m backend.demo.run_isolated --port 8011
    python -m backend.demo.run_isolated --reset --port 8011
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.demo import isolation  # noqa: E402
from backend.demo.isolation import IsolationError  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run PACTORA in an isolated Guided Demonstration environment."
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=isolation.DEFAULT_STATE_DIR,
        help="Dedicated directory for the demo database and evidence.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete and recreate only the isolated demo state before starting.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument(
        "--cors-origin-regex",
        default=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
        help="Allowed browser origin for the separately served demo UI.",
    )
    parser.add_argument(
        "--no-cors",
        action="store_true",
        help="Do not enable CORS for the isolated demo backend.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        paths = isolation.prepare_state(args.state_dir, reset=args.reset)
    except IsolationError as error:
        print(f"Isolation error: {error}", file=sys.stderr)
        return 2

    # Demo-only process flag. Credentials still come from backend/.env unless
    # the caller already provides them in the environment.
    os.environ["PACTORA_DEMO_MODE"] = "1"

    from backend.app import main as app_main

    try:
        isolation.install_isolated_paths(app_main, paths)
        isolation.assert_bound(app_main, paths)
    except IsolationError as error:
        print(f"Isolation error: {error}", file=sys.stderr)
        return 2

    if not args.no_cors:
        from fastapi.middleware.cors import CORSMiddleware

        app_main.app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=args.cors_origin_regex,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["X-Request-ID"],
        )

    print("PACTORA isolated Guided Demonstration")
    print(f"  database: {paths.db_path}")
    print(f"  evidence: {paths.evidence_dir}")
    print(f"  state:    {paths.state_dir}")
    print(f"  reset:    python -m backend.demo.run_isolated --reset "
          f"--state-dir \"{paths.state_dir}\"")
    print()
    print("Frontend (separate terminal, uses runtime env only):")
    print(
        '  $env:VITE_API_BASE="http://127.0.0.1:'
        f'{args.port}"; cd frontend; npm run dev -- --port 5174'
    )
    print()
    print("Open http://127.0.0.1:5174/demo")
    print()

    import uvicorn

    uvicorn.run(app_main.app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
