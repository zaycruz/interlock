"""Prove that scope and contract failures remain blocking after extraction."""
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path


def load_runner():
    spec = importlib.util.spec_from_file_location("engineering", Path(__file__).with_name("engineering.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runner = load_runner()


class ScopeContractTest(unittest.TestCase):
    def test_new_oversized_code_and_missing_justification_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            subprocess.run(["git", "-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "baseline"], check=True)
            (root / "src").mkdir()
            (root / "src/example.ts").write_text("export {};\n" * 501)
            profile = {"project": {"base_ref": "HEAD"}, "scope": {"configuration_paths": ["src/"]}}
            size = runner.file_size_results(root, profile, False)
            self.assertEqual([(r.status, r.actual, r.limit) for r in size], [("FAIL", 501, 500)])
            self.assertEqual(runner.contract_results(root, profile, False)[0].status, "FAIL")
            (root / ".engineering").mkdir()
            (root / runner.CONTRACT_NAME).write_text('[[justifications]]\ntrigger = "configuration_change"\nreason = "Fixture proves an explicit contract is required."\n')
            self.assertTrue(all(r.status == "PASS" for r in runner.contract_results(root, profile, False)))
            (root / "src/example.ts").write_text("export {};\n" * 500)
            self.assertEqual(runner.file_size_results(root, profile, False)[0].status, "PASS")

    def test_reuse_and_test_use_case_validation(self):
        self.assertEqual(runner.reuse_result({}).status, "FAIL")
        self.assertEqual(runner.reuse_result({"reuse_checks": [{"new_symbol": "scope", "search": "existing runner", "reason": "Extract existing scope functions."}]}).status, "PASS")
        self.assertEqual(runner.justification_results(["scope_limit"], {})[0].status, "FAIL")

    def test_format_checks_the_requested_revision_or_working_tree(self):
        profile = tomllib.loads(Path(__file__).resolve().parents[1].joinpath("engineering.toml").read_text())
        command = next(check["command"] for check in profile["checks"] if check["id"] == "format")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args], text=True).strip()
            git("init", "-q")
            source = root / "example.ts"
            source.write_text("export {};\n")
            git("add", "example.ts")
            git("commit", "-qm", "Establish format baseline")
            base = git("rev-parse", "HEAD")
            source.write_text("export const value = 1;\n\n")
            git("commit", "-qam", "Record invalid historical whitespace")
            source.write_text("export const value = 1;\n")
            env = {**os.environ, "ENGINEERING_BASE_REF": base, "ENGINEERING_HEAD_REF": ""}
            def check():
                return subprocess.run(command, cwd=root, shell=True, env=env, capture_output=True).returncode
            self.assertEqual(check(), 0)
            env["ENGINEERING_HEAD_REF"] = "HEAD"
            self.assertNotEqual(check(), 0)
            env["ENGINEERING_HEAD_REF"] = ""
            git("add", "example.ts")
            (root / "engineering.toml").write_text(
                '[project]\nbase_ref = "HEAD"\n[[checks]]\nid = "format"\nphase = "fast"\npreserve_git_context = true\ncommand = '
                + json.dumps(command) + "\n")
            def gate(*args):
                return subprocess.run([sys.executable, str(Path(__file__).with_name("engineering.py")), "--path", str(root), "quality-gate", "--staged", "--base", base, *args], cwd=root, env=env, capture_output=True, text=True)
            staged = gate()
            self.assertEqual(staged.returncode, 0, staged.stdout + staged.stderr)
            self.assertNotEqual(gate("--head", "HEAD").returncode, 0)
            source.write_text("export const value = 1;\n\n")
            self.assertNotEqual(check(), 0)
            self.assertNotEqual(gate().returncode, 0)


    def test_real_hook_isolates_fixture_git_and_preserves_alternate_index(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            source = temporary / "source"
            foreign = temporary / "foreign"
            source.mkdir()
            clean_env = os.environ.copy()
            for name in subprocess.check_output(["git", "rev-parse", "--local-env-vars"], text=True).splitlines():
                clean_env.pop(name, None)
            def git(*args, env=clean_env):
                return subprocess.check_output(["git", "-C", str(source), "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args], env=env, text=True).strip()
            git("init", "-q")
            (source / "base.txt").write_text("baseline")
            git("add", "base.txt")
            git("commit", "-qm", "Establish source baseline")
            alternate = temporary / "alternate-index"
            hook_env = {**clean_env, "GIT_DIR": str(source / ".git"), "GIT_INDEX_FILE": str(alternate),
                        "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.quotePath", "GIT_CONFIG_VALUE_0": "false"}
            git("read-tree", "HEAD", env=hook_env)
            (source / "staged.txt").write_text("staged only in alternate index")
            git("add", "staged.txt", env=hook_env)
            original_head = git("rev-parse", "HEAD")
            original_config = (source / ".git/config").read_bytes()
            original_index = (source / ".git/index").read_bytes()
            original_alternate_tree = git("write-tree", env=hook_env)
            fixture = temporary / "fixture.py"
            fixture.write_text(textwrap.dedent(f"""
                import os
                import subprocess
                from pathlib import Path
                root = Path({str(foreign)!r})
                local_names = subprocess.check_output(["git", "rev-parse", "--local-env-vars"], text=True).splitlines()
                assert not set(local_names).intersection(os.environ)
                assert not any(name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")) for name in os.environ)
                assert os.environ["ENGINEERING_CHANGED_FILES"] == "staged.txt"
                subprocess.run(["git", "init", "-q", str(root)], check=True)
                def git(*args):
                    subprocess.run(["git", "-C", str(root), "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args], check=True)
                (root / "foreign.txt").write_text("foreign fixture")
                git("add", "foreign.txt")
                git("commit", "-qm", "Commit fixture data")
                git("config", "core.bare", "true")
            """))
            evidence = temporary / "evidence.json"
            driver = temporary / "hook.py"
            runner_dir = Path(__file__).resolve().parent
            driver.write_text(textwrap.dedent(f"""
                import json
                import os
                import sys
                from pathlib import Path
                sys.path.insert(0, {str(runner_dir)!r})
                import engineering
                root = Path({str(source)!r})
                profile = {{"project": {{"base_ref": "HEAD"}}}}
                before = engineering.changed_files(root, profile, True)
                incoming_index = os.environ["GIT_INDEX_FILE"]
                result = engineering.run_check(root, {{"id": "fixture", "command": {shlex.join([sys.executable, str(fixture)])!r}}}, before)
                format_result = engineering.run_check(root, {{"id": "format", "command": "git diff --cached --name-only", "preserve_git_context": True}}, before)
                after = engineering.changed_files(root, profile, True)
                Path({str(evidence)!r}).write_text(json.dumps({{"status": result.status, "output": result.output, "before": before, "after": after, "format_status": format_result.status, "format_files": format_result.output, "index_preserved": os.environ["GIT_INDEX_FILE"] == incoming_index}}))
                raise SystemExit(1)
            """))
            hook = source / ".git/hooks/pre-commit"
            hook.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(driver)]) + "\n")
            hook.chmod(0o755)
            attempted = subprocess.run(["git", "-C", str(source), "-c", "core.hooksPath=" + str(hook.parent), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Hook rejects this commit"], env=hook_env, capture_output=True, text=True)
            self.assertNotEqual(attempted.returncode, 0)
            observed = json.loads(evidence.read_text())
            self.assertEqual(observed["status"], "PASS", observed["output"])
            self.assertEqual(observed["format_status"], "PASS")
            self.assertEqual(observed["format_files"], "staged.txt")
            self.assertEqual(observed["before"], ["staged.txt"])
            self.assertEqual(observed["after"], ["staged.txt"])
            self.assertTrue(observed["index_preserved"])
            self.assertEqual(git("rev-parse", "HEAD"), original_head)
            self.assertEqual((source / ".git/config").read_bytes(), original_config)
            self.assertEqual((source / ".git/index").read_bytes(), original_index)
            self.assertEqual(git("write-tree", env=hook_env), original_alternate_tree)
            self.assertEqual(subprocess.check_output(["git", "-C", str(foreign), "config", "core.bare"], env=clean_env, text=True).strip(), "true")


if __name__ == "__main__":
    unittest.main()
