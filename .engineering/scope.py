"""Git scope, file-size, and change-contract analysis for the quality runner."""
from __future__ import annotations

import os
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONTRACT_NAME = ".engineering/change-contract.toml"
CODE_SUFFIXES = {".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".php", ".py", ".rb", ".rs", ".scala", ".swift", ".ts", ".tsx"}

@dataclass
class Result:
    identifier: str
    status: str
    message: str
    output: str = ""
    file: str | None = None
    symbol: str | None = None
    actual: int | None = None
    limit: int | None = None


def load_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)


def git_output(root: Path, args: list[str]) -> str:
    completed = run(["git", *args], root)
    return completed.stdout.strip() if completed.returncode == 0 else ""


def base_ref(root: Path, profile: dict[str, Any]) -> str:
    requested = os.environ.get("ENGINEERING_BASE_REF")
    configured = profile.get("project", {}).get("base_ref", "main")
    for candidate in (requested, configured, "HEAD~1"):
        if candidate and git_output(root, ["rev-parse", "--verify", candidate]):
            return candidate
    return ""


def comparison_base(root: Path, profile: dict[str, Any]) -> str:
    base = base_ref(root, profile)
    head = os.environ.get("ENGINEERING_HEAD_REF", "HEAD")
    compare = profile.get("scope", {}).get("compare", "merge-base")
    if base and compare == "merge-base":
        merged = git_output(root, ["merge-base", base, head])
        if merged:
            return merged
    return base


def diff_args(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    if staged:
        return ["diff", "--cached"]
    base = comparison_base(root, profile)
    head = os.environ.get("ENGINEERING_HEAD_REF", "")
    # Compare the working tree to the base. A three-dot range excludes edits
    # that an agent has not committed yet, which hides the very changes local
    # hooks must evaluate.
    if base and head:
        return ["diff", base, head]
    return ["diff", base] if base else ["diff"]


def changed_files(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    output = git_output(root, [*diff_args(root, profile, staged), "--name-only", "--diff-filter=ACMR"])
    tracked = [line for line in output.splitlines() if line]
    if staged:
        return tracked
    untracked = git_output(root, ["ls-files", "--others", "--exclude-standard"]).splitlines()
    return list(dict.fromkeys([*tracked, *[path for path in untracked if path]]))


def line_stats(root: Path, profile: dict[str, Any], staged: bool) -> tuple[int, int]:
    output = git_output(root, [*diff_args(root, profile, staged), "--numstat"])
    added = removed = 0
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) < 2 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        added += int(fields[0])
        removed += int(fields[1])
    if not staged:
        tracked = set(git_output(root, [*diff_args(root, profile, staged), "--name-only"]).splitlines())
        for path in changed_files(root, profile, staged):
            if path not in tracked:
                try:
                    added += len((root / path).read_text().splitlines())
                except UnicodeDecodeError:
                    continue
    return added, removed


def line_stats_for_paths(root: Path, profile: dict[str, Any], staged: bool, paths: list[str]) -> tuple[int, int]:
    output = git_output(root, [*diff_args(root, profile, staged), "--numstat"])
    added = removed = 0
    selected = set(paths)
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) < 3 or fields[2] not in selected:
            continue
        if fields[0].isdigit() and fields[1].isdigit():
            added += int(fields[0])
            removed += int(fields[1])
    return added, removed


def path_matches(path: str, patterns: list[str]) -> bool:
    return any(Path(path).match(pattern) or path.startswith(pattern) for pattern in patterns)


def scope_results(root: Path, profile: dict[str, Any], staged: bool) -> tuple[list[Result], bool]:
    scope = profile.get("scope", {})
    paths = changed_files(root, profile, staged)
    added, removed = line_stats(root, profile, staged)
    results: list[Result] = []
    review_required = False
    limits = (("files", len(paths), scope.get("warn_files", 12), scope.get("review_files", 20)),
              ("added_lines", added, scope.get("warn_added_lines", 500), scope.get("review_added_lines", 1000)))
    for name, value, warning, review in limits:
        status = "PASS" if value <= warning else "WARN"
        results.append(Result(f"scope.{name}", status, f"{value}; warning at {warning}"))
        review_required = review_required or value >= review
    categories = (("dependency_change", "dependency_files"),
                  ("public_api_change", "public_api_paths"),
                  ("configuration_change", "configuration_paths"))
    for name, key in categories:
        matches = [path for path in paths if path_matches(path, scope.get(key, []))]
        if matches:
            results.append(Result(f"scope.{name}", "WARN", ", ".join(matches)))
            review_required = True
    results.append(Result("scope.lines_removed", "PASS", str(removed)))
    return results, review_required


def production_paths(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    scope = profile.get("scope", {})
    included = scope.get("production_paths", ["src/**", "app/**", "lib/**"])
    excluded = scope.get("excluded_paths", ["**/*.test.*", "**/*.spec.*", "generated/**"])
    return [path for path in changed_files(root, profile, staged) if path_matches(path, included) and not path_matches(path, excluded)]


def test_paths(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    patterns = profile.get("scope", {}).get("test_paths", ["test/**", "tests/**", "spec/**", "**/*.test.*", "**/*.spec.*"])
    return [path for path in changed_files(root, profile, staged) if path_matches(path, patterns)]


def code_path(path: str) -> bool:
    return Path(path).suffix in CODE_SUFFIXES


def file_lines(path: Path) -> int:
    try:
        return len(path.read_text().splitlines())
    except (OSError, UnicodeDecodeError):
        return 0


def base_file_lines(root: Path, profile: dict[str, Any], path: str) -> int:
    base = comparison_base(root, profile)
    if not base:
        return 0
    completed = run(["git", "show", f"{base}:{path}"], root)
    return len(completed.stdout.splitlines()) if completed.returncode == 0 else 0


def file_size_results(root: Path, profile: dict[str, Any], staged: bool) -> list[Result]:
    limit = profile.get("scope", {}).get("max_lines_per_new_or_modified_file", 500)
    results: list[Result] = []
    for path in changed_files(root, profile, staged):
        if not code_path(path):
            continue
        current = file_lines(root / path)
        previous = base_file_lines(root, profile, path)
        if current > limit and current > previous:
            results.append(Result("size.max_lines_per_new_or_modified_file", "FAIL", "file grew beyond limit", file=path, actual=current, limit=limit))
    return results or [Result("size.max_lines_per_new_or_modified_file", "PASS", f"at most {limit} lines")]


def new_production_paths(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    output = git_output(root, [*diff_args(root, profile, staged), "--name-only", "--diff-filter=A"])
    candidates = [path for path in output.splitlines() if path]
    return [path for path in candidates if path in production_paths(root, profile, staged)]


def new_test_paths(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    output = git_output(root, [*diff_args(root, profile, staged), "--name-only", "--diff-filter=A"])
    candidates = [path for path in output.splitlines() if path]
    return [path for path in candidates if path in test_paths(root, profile, staged)]


def contract_triggers(root: Path, profile: dict[str, Any], staged: bool) -> list[str]:
    scope = profile.get("scope", {})
    production = production_paths(root, profile, staged)
    new_modules = new_production_paths(root, profile, staged)
    new_tests = new_test_paths(root, profile, staged)
    added, removed = line_stats_for_paths(root, profile, staged, production)
    paths = changed_files(root, profile, staged)
    triggers: list[str] = []
    if len(production) > scope.get("max_modified_production_files", 8):
        triggers.append("scope_limit")
    if added > scope.get("max_added_or_changed_production_loc", 300):
        triggers.append("scope_limit")
    if added + removed > scope.get("max_total_added_or_deleted_loc", 500):
        triggers.append("scope_limit")
    if len(new_modules) > scope.get("max_new_production_modules", 2):
        triggers.append("new_module")
    if new_tests:
        triggers.append("new_test_file")
    dependency_files = scope.get("dependency_files", [])
    if dependency_files and any(path_matches(path, dependency_files) for path in paths):
        triggers.append("new_dependency")
    if any(path_matches(path, scope.get("public_api_paths", [])) for path in paths):
        triggers.append("public_api_change")
    if any(path_matches(path, scope.get("configuration_paths", [])) for path in paths):
        triggers.append("configuration_change")
    return list(dict.fromkeys(triggers))


def justification_results(triggers: list[str], contract: dict[str, Any]) -> list[Result]:
    entries = contract.get("justifications", [])
    valid = {entry.get("trigger") for entry in entries if isinstance(entry, dict) and entry.get("reason")}
    return [Result(f"contract.{trigger}", "PASS" if trigger in valid else "FAIL",
                   "justified" if trigger in valid else "missing justification") for trigger in triggers]


def reuse_result(contract: dict[str, Any]) -> Result:
    entries = contract.get("reuse_checks", [])
    valid = [entry for entry in entries if isinstance(entry, dict) and entry.get("new_symbol") and entry.get("search") and entry.get("reason")]
    return Result("contract.reuse_search", "PASS" if valid else "FAIL", "recorded" if valid else "missing reuse search")


def test_use_case_result(root: Path, profile: dict[str, Any], staged: bool, contract: dict[str, Any]) -> Result:
    entries = contract.get("test_cases", [])
    valid = [entry for entry in entries if isinstance(entry, dict) and entry.get("test_file") and entry.get("use_case") and entry.get("behavior")]
    documented = {str(entry["test_file"]) for entry in valid}
    missing = sorted(set(new_test_paths(root, profile, staged)) - documented)
    return Result("contract.test_use_case", "PASS" if not missing else "FAIL",
                  "documented" if not missing else f"missing use case: {', '.join(missing)}")


def contract_results(root: Path, profile: dict[str, Any], staged: bool) -> list[Result]:
    triggers = contract_triggers(root, profile, staged)
    if not triggers:
        return [Result("contract.required", "PASS", "not required")]
    path = root / CONTRACT_NAME
    if not path.exists():
        return [Result("contract.required", "FAIL", f"required for: {', '.join(triggers)}")]
    contract = load_toml(path)
    results = justification_results(triggers, contract)
    if "new_module" in triggers:
        results.append(reuse_result(contract))
    if "new_test_file" in triggers:
        results.append(test_use_case_result(root, profile, staged, contract))
    return results
