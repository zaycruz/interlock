#!/usr/bin/env python3
"""Portable, profile-driven engineering checks for coding agents and CI."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from scope import (
    CONTRACT_NAME, Result, changed_files, comparison_base, contract_results,
    file_size_results, git_output, justification_results, load_toml, reuse_result,
    run, scope_results,
)


ROOT = Path(__file__).resolve().parents[1]
PROFILE_NAME = "engineering.toml"
BASELINE_NAME = ".engineering/baseline.json"
EXCEPTIONS_NAME = ".engineering/exceptions.toml"
REPORT_NAME = ".engineering/quality-report.json"
FAST_PHASE = "fast"


def command_environment(root: Path, paths: list[str], preserve_git_context: bool = False) -> dict[str, str]:
    environment = os.environ.copy()
    if not preserve_git_context:
        local_names = subprocess.check_output(["git", "rev-parse", "--local-env-vars"], cwd=root, text=True).splitlines()
        # Hooks export repository and index locations. Fixture commands must select their own repository.
        for name in local_names:
            environment.pop(name, None)
        for name in list(environment):
            if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
                del environment[name]
    environment["ENGINEERING_CHANGED_FILES"] = "\n".join(paths)
    environment["ENGINEERING_CHANGED_FILE_COUNT"] = str(len(paths))
    return environment


def run_check(root: Path, check: dict[str, Any], paths: list[str]) -> Result:
    identifier = str(check["id"])
    command = str(check.get("command", "")).strip()
    if not command:
        return Result(identifier, "WARN", "not configured")
    completed = subprocess.run(command, cwd=root, shell=True, text=True, capture_output=True,
                               env=command_environment(root, paths, check.get("preserve_git_context") is True), check=False)
    output = (completed.stdout + completed.stderr).strip()
    if completed.returncode == 0:
        return Result(identifier, "PASS", "command passed", output)
    severity = str(check.get("severity", "fail")).upper()
    status = "WARN" if severity == "WARN" else "FAIL"
    return Result(identifier, status, f"command exited {completed.returncode}", output)


def fingerprint(result: Result) -> str:
    normalized = "\n".join(line.rstrip() for line in result.output.splitlines()).strip()
    return hashlib.sha256(normalized.encode()).hexdigest()


def load_baseline(root: Path) -> dict[str, Any]:
    path = root / BASELINE_NAME
    return json.loads(path.read_text()) if path.exists() else {"checks": {}}


def apply_ratchet(result: Result, check: dict[str, Any], baseline: dict[str, Any]) -> Result:
    if check.get("ratchet") != "baseline" or result.status == "PASS":
        return result
    previous = baseline.get("checks", {}).get(result.identifier)
    if not previous:
        return Result(result.identifier, "FAIL", "missing reviewed baseline", result.output)
    if previous.get("fingerprint") != fingerprint(result):
        return Result(result.identifier, "FAIL", "baseline failure changed", result.output)
    return Result(result.identifier, "WARN", "known baseline failure", result.output)


def active_exception(root: Path, result: Result) -> dict[str, Any] | None:
    path = root / EXCEPTIONS_NAME
    if not path.exists():
        return None
    today = dt.date.today().isoformat()
    for entry in load_toml(path).get("exceptions", []):
        if entry.get("rule") != result.identifier:
            continue
        expires = str(entry.get("expires", ""))
        if expires and expires < today:
            continue
        if not entry.get("location") or not entry.get("reason") or not entry.get("owner"):
            continue
        return entry
    return None


def apply_exceptions(root: Path, results: list[Result]) -> list[Result]:
    resolved: list[Result] = []
    for result in results:
        exception = active_exception(root, result)
        if exception and result.status in {"FAIL", "WARN"}:
            resolved.append(Result(result.identifier, "EXCEPTION", exception["reason"], result.output, result.file, result.symbol, result.actual, result.limit))
        else:
            resolved.append(result)
    return resolved


def select_checks(profile: dict[str, Any], full: bool, only: list[str] | None = None) -> list[dict[str, Any]]:
    checks = profile.get("checks", [])
    selected = checks if full else [check for check in checks if check.get("phase", FAST_PHASE) == FAST_PHASE]
    return [check for check in selected if not only or check.get("id") in only]


def check(root: Path, full: bool, staged: bool, only: list[str] | None = None) -> tuple[list[Result], bool]:
    profile_path = root / PROFILE_NAME
    if not profile_path.exists():
        return [Result("profile", "FAIL", f"missing {PROFILE_NAME}")], False
    profile = load_toml(profile_path)
    paths = changed_files(root, profile, staged)
    baseline = load_baseline(root)
    results = [apply_ratchet(run_check(root, item, paths), item, baseline) for item in select_checks(profile, full, only)]
    scope, review_required = scope_results(root, profile, staged)
    return apply_exceptions(root, [*results, *scope, *file_size_results(root, profile, staged)]), review_required


def render(results: list[Result], as_json: bool) -> None:
    if as_json:
        print(json.dumps([asdict(result) for result in results], indent=2))
        return
    for result in results:
        print(f"{result.status:9} {result.identifier}: {result.message}")
        if result.output and result.status in {"FAIL", "WARN"}:
            print(result.output)


def command_check(args: argparse.Namespace) -> int:
    results, _ = check(Path(args.path).resolve(), args.full, args.staged, args.only)
    render(results, args.json)
    return int(any(result.status == "FAIL" for result in results))


def command_scope(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve()
    profile = load_toml(root / PROFILE_NAME)
    results, required = scope_results(root, profile, args.staged)
    render(results, args.json)
    print(f"review_required={str(required).lower()}")
    return 0


def command_review_needed(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve()
    profile = load_toml(root / PROFILE_NAME)
    _, required = scope_results(root, profile, args.staged)
    value = str(required).lower()
    if args.github_output:
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            Path(output).write_text(f"review_required={value}\n")
    print(value)
    return 0


def command_baseline(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve()
    profile = load_toml(root / PROFILE_NAME)
    paths = changed_files(root, profile, False)
    records: dict[str, Any] = {}
    for item in profile.get("checks", []):
        if item.get("ratchet") != "baseline":
            continue
        result = run_check(root, item, paths)
        records[result.identifier] = {"fingerprint": fingerprint(result), "status": result.status}
    destination = root / BASELINE_NAME
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {"created_at": dt.datetime.now(dt.UTC).isoformat(), "owner": args.owner, "checks": records}
    destination.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {destination}")
    return 0


def revision(root: Path, reference: str) -> str:
    return git_output(root, ["rev-parse", reference]) if reference else ""


def report_payload(root: Path, profile: dict[str, Any], results: list[Result]) -> dict[str, Any]:
    base = comparison_base(root, profile)
    violations = [{"rule": result.identifier, "message": result.message, "file": result.file,
                   "symbol": result.symbol, "actual": result.actual, "limit": result.limit}
                  for result in results if result.status == "FAIL"]
    return {"passed": not violations, "base_sha": revision(root, base), "head_sha": revision(root, "HEAD"), "violations": violations}


def command_quality_gate(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve()
    profile_path = root / PROFILE_NAME
    if not profile_path.exists():
        results = [Result("profile", "FAIL", f"missing {PROFILE_NAME}")]
        payload = {"passed": False, "base_sha": "", "head_sha": revision(root, "HEAD"), "violations": [{"rule": "profile", "message": results[0].message}]}
    else:
        if args.base:
            os.environ["ENGINEERING_BASE_REF"] = args.base
        if args.head:
            os.environ["ENGINEERING_HEAD_REF"] = args.head
        profile = load_toml(profile_path)
        results, _ = check(root, True, args.staged)
        results = [*results, *contract_results(root, profile, args.staged)]
        results = apply_exceptions(root, results)
        payload = report_payload(root, profile, results)
    destination = root / args.report
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    render(results, args.json)
    print(f"quality report: {destination}")
    return int(not payload["passed"])


def command_contract(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve()
    profile_path = root / PROFILE_NAME
    if not profile_path.exists():
        results = [Result("profile", "FAIL", f"missing {PROFILE_NAME}")]
    else:
        results = contract_results(root, load_toml(profile_path), args.staged)
    render(results, args.json)
    return int(any(result.status == "FAIL" for result in results))


def detected_commands(target: Path) -> dict[str, str]:
    if (target / "package.json").exists():
        package = json.loads((target / "package.json").read_text())
        scripts = package.get("scripts", {})
        return {key: f"npm run {key}" for key in ("format", "lint", "typecheck", "test", "build") if key in scripts}
    if (target / "pyproject.toml").exists():
        source = (target / "pyproject.toml").read_text()
        return {"format": "python3 -m ruff format --check ." if "ruff" in source else "",
                "lint": "python3 -m ruff check ." if "ruff" in source else "",
                "typecheck": "python3 -m mypy ." if "mypy" in source else "",
                "test": "python3 -m pytest" if "pytest" in source else ""}
    if (target / "go.mod").exists():
        return {"format": "test -z \"$(gofmt -l .)\"", "lint": "go vet ./...", "test": "go test ./..."}
    if (target / "Cargo.toml").exists():
        return {"format": "cargo fmt --check", "lint": "cargo clippy -- -D warnings", "test": "cargo test", "build": "cargo build"}
    if (target / "Package.swift").exists():
        return {"test": "swift test", "build": "swift build"}
    return {}


def detected_languages(target: Path) -> list[str]:
    if (target / "package.json").exists():
        return ["typescript" if (target / "tsconfig.json").exists() else "javascript"]
    if (target / "pyproject.toml").exists():
        return ["python"]
    if (target / "go.mod").exists():
        return ["go"]
    if (target / "Cargo.toml").exists():
        return ["rust"]
    if (target / "Package.swift").exists() or list(target.glob("*.xcodeproj")):
        return ["swift"]
    return []


def profile_with_commands(template: str, commands: dict[str, str], name: str, languages: list[str]) -> str:
    lines = template.replace('name = "replace-me"', f'name = "{name}"').splitlines()
    identifier = ""
    rendered: list[str] = []
    for line in lines:
        if line == "languages = []":
            line = f"languages = {json.dumps(languages)}"
        if line.startswith('id = "'):
            identifier = line.split('"')[1]
        if line == 'command = ""' and identifier in commands:
            line = f"command = {json.dumps(commands[identifier])}"
        rendered.append(line)
    return "\n".join(rendered) + "\n"


def copy_if_missing(source: Path, destination: Path) -> None:
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def command_init(args: argparse.Namespace) -> int:
    target = Path(args.path).resolve()
    if not (target / ".git").exists():
        print(f"{target} is not a Git repository", file=sys.stderr)
        return 1
    template = (ROOT / "templates/engineering.toml").read_text()
    profile = target / PROFILE_NAME
    if profile.exists() and not args.force:
        print(f"kept {profile}")
    else:
        profile.write_text(profile_with_commands(template, detected_commands(target), target.name, detected_languages(target)))
        print(f"wrote {profile}")
    copy_if_missing(ROOT / "templates/AGENTS.md", target / "AGENTS.md")
    copy_if_missing(ROOT / "templates/.gitignore", target / ".gitignore")
    copy_if_missing(Path(__file__), target / ".engineering/engineering.py")
    copy_if_missing(Path(__file__).with_name("scope.py"), target / ".engineering/scope.py")
    for skill in (ROOT / "templates/skills").iterdir():
        destination = target / ".codex/skills" / skill.name / "SKILL.md"
        copy_if_missing(skill / "SKILL.md", destination)
    copy_if_missing(ROOT / "templates/hooks/pre-commit", target / ".githooks/pre-commit")
    copy_if_missing(ROOT / "templates/hooks/pre-push", target / ".githooks/pre-push")
    copy_if_missing(ROOT / "templates/hooks/engineering-quality.mjs", target / ".omx/hooks/engineering-quality.mjs")
    copy_if_missing(ROOT / "templates/.github/workflows/engineering-quality.yml", target / ".github/workflows/engineering-quality.yml")
    copy_if_missing(ROOT / "templates/scripts/quality-gate", target / "scripts/quality-gate")
    run(["git", "config", "core.hooksPath", ".githooks"], target)
    print("review engineering.toml, then run the fast gate")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--path", default=".", help="target repository")
    sub = result.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init")
    init.add_argument("path", nargs="?", default=".")
    init.add_argument("--force", action="store_true")
    init.set_defaults(handler=command_init)
    check_parser = sub.add_parser("check")
    check_parser.add_argument("--fast", action="store_false", dest="full")
    check_parser.add_argument("--full", action="store_true")
    check_parser.add_argument("--staged", action="store_true")
    check_parser.add_argument("--json", action="store_true")
    check_parser.add_argument("--only", action="append", default=[])
    check_parser.set_defaults(full=False, handler=command_check)
    scope = sub.add_parser("scope")
    scope.add_argument("--staged", action="store_true")
    scope.add_argument("--json", action="store_true")
    scope.set_defaults(handler=command_scope)
    review = sub.add_parser("review-needed")
    review.add_argument("--staged", action="store_true")
    review.add_argument("--github-output", action="store_true")
    review.set_defaults(handler=command_review_needed)
    baseline = sub.add_parser("baseline")
    baseline.add_argument("--owner", required=True)
    baseline.set_defaults(handler=command_baseline)
    quality = sub.add_parser("quality-gate")
    quality.add_argument("--base", default="")
    quality.add_argument("--head", default="")
    quality.add_argument("--report", default=REPORT_NAME)
    quality.add_argument("--staged", action="store_true")
    quality.add_argument("--json", action="store_true")
    quality.set_defaults(handler=command_quality_gate)
    contract = sub.add_parser("contract")
    contract.add_argument("--staged", action="store_true")
    contract.add_argument("--json", action="store_true")
    contract.set_defaults(handler=command_contract)
    return result


def main() -> int:
    arguments = parser().parse_args()
    return arguments.handler(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
