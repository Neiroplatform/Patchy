from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/fuzz/run_psd_campaign.py"
VALIDATOR = ROOT / "scripts/fuzz/validate_psd_campaign.py"
sys.path.insert(0, os.fspath(ROOT / "scripts/fuzz"))

from run_psd_campaign import _arguments, _result  # noqa: E402


class CampaignToolsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", self.source], check=True)
        subprocess.run(["git", "-C", self.source, "config", "user.name", "Fixture"], check=True)
        subprocess.run(["git", "-C", self.source, "config", "user.email", "fixture@example.invalid"], check=True)
        (self.source / "README").write_text("fixture\n", encoding="utf-8")
        subprocess.run(["git", "-C", self.source, "add", "README"], check=True)
        subprocess.run(["git", "-C", self.source, "commit", "-qm", "fixture"], check=True)
        self.source_sha = subprocess.run(
            ["git", "-C", self.source, "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.seeds = self.base / "seeds"
        self.seeds.mkdir()
        (self.seeds / "valid.psd").write_bytes(b"8BPS\x00\x01")
        (self.seeds / "valid.psb").write_bytes(b"8BPS\x00\x02")
        self.dictionary = self.base / "psd.dict"
        self.dictionary.write_text('signature="8BPS"\n', encoding="ascii")
        self.executable = self._fake_fuzzer("fuzzer", 0, clean=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _fake_fuzzer(self, name: str, exit_code: int, *, clean: bool) -> Path:
        path = self.base / name
        lines = [
            "#!/usr/bin/env python3",
            "from pathlib import Path",
            "import sys",
            "print('#1000 DONE cov: 17 ft: 23 corp: 4/32b', file=sys.stderr)",
            "print('stat::number_of_executed_units: 1000', file=sys.stderr)",
            "print('stat::new_units_added: 3', file=sys.stderr)",
        ]
        if not clean:
            lines.extend([
                "Path('artifacts/crash-0001').write_bytes(b'finding')",
                "print('libFuzzer: deadly signal', file=sys.stderr)",
            ])
        lines.append(f"raise SystemExit({exit_code})")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def _run(self, executable: Path | None = None, suffix: str = "pass") -> tuple[subprocess.CompletedProcess[str], Path, Path]:
        evidence = self.base / f"evidence-{suffix}"
        receipt = self.base / f"receipt-{suffix}.json"
        result = subprocess.run(
            [
                sys.executable, os.fspath(RUNNER),
                "--executable", os.fspath(executable or self.executable),
                "--seed-corpus", os.fspath(self.seeds),
                "--dictionary", os.fspath(self.dictionary),
                "--patchy-source", os.fspath(self.source),
                "--evidence-root", os.fspath(evidence),
                "--receipt", os.fspath(receipt),
            ],
            capture_output=True, text=True, check=False,
        )
        return result, evidence, receipt

    def _validate(self, receipt: Path, evidence: Path, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable, os.fspath(VALIDATOR), os.fspath(receipt), os.fspath(evidence),
                "--expected-patchy-sha", self.source_sha, *extra,
            ],
            capture_output=True, text=True, check=False,
        )

    def test_clean_campaign_emits_root_compatible_closed_receipt(self) -> None:
        result, evidence, receipt = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(value["status"], "PASS")
        self.assertEqual(value["result"]["executed_units"], 1000)
        self.assertEqual(value["result"]["new_units"], 3)
        self.assertEqual(value["seed_corpus"]["file_count"], 2)
        self.assertEqual(value["artifacts"]["file_count"], 0)
        self.assertFalse(value["patchy_dirty"])
        checked = self._validate(receipt, evidence, "--check", os.fspath(receipt))
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(checked.stdout, "PASS\n")
        files = {path.relative_to(evidence).as_posix() for path in evidence.rglob("*") if path.is_file()}
        self.assertEqual(files, {
            "bin/patchy_psd_fuzzer", "inputs/psd.dict", "logs/fuzz.log",
            "seed/valid.psb", "seed/valid.psd",
        })

    def test_single_process_invocation_does_not_enable_libfuzzer_job_logs(self) -> None:
        arguments = _arguments()

        self.assertNotIn("-jobs=1", arguments)
        self.assertNotIn("-workers=1", arguments)
        self.assertIn("-runs=1000", arguments)

    def test_crash_is_a_consistent_fail_receipt(self) -> None:
        fuzzer = self._fake_fuzzer("crashing", 77, clean=False)
        result, evidence, receipt = self._run(fuzzer, "crash")
        self.assertEqual(result.returncode, 1, result.stderr)
        value = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(value["status"], "FAIL")
        self.assertEqual(value["result"]["crash_count"], 1)
        self.assertEqual(value["result"]["finding_count"], 1)
        self.assertEqual(value["failure_reasons"], ["ARTIFACT_PRESENT", "CRASH", "NONZERO_EXIT"])
        self.assertEqual(self._validate(receipt, evidence).returncode, 1)

    def test_timeout_without_native_artifact_is_still_recordable(self) -> None:
        status, result, reasons = _result(
            124,
            True,
            b"runner timeout after bounded campaign window\n",
            1,
        )
        self.assertEqual(status, "FAIL")
        self.assertEqual(result["stop_reason"], "timeout")
        self.assertEqual(result["timeout_count"], 1)
        self.assertEqual(result["finding_count"], 1)
        self.assertEqual(
            reasons,
            ["ARTIFACT_PRESENT", "NONZERO_EXIT", "TIMEOUT"],
        )

    def test_tampering_duplicate_fields_and_noncanonical_check_fail_closed(self) -> None:
        _, evidence, receipt = self._run()
        (evidence / "logs/fuzz.log").write_text("tampered\n", encoding="utf-8")
        self.assertEqual(self._validate(receipt, evidence).returncode, 2)

        _, evidence2, receipt2 = self._run(suffix="duplicate")
        raw = receipt2.read_bytes()
        receipt2.write_bytes(raw.replace(b'{\n  "artifacts":', b'{\n  "status": "PASS",\n  "artifacts":', 1))
        duplicate = self._validate(receipt2, evidence2)
        self.assertEqual(duplicate.returncode, 2)
        self.assertIn("duplicate JSON member", duplicate.stderr)

        _, evidence3, receipt3 = self._run(suffix="noncanonical")
        canonical = receipt3.read_bytes()
        noncanonical = self.base / "noncanonical.json"
        noncanonical.write_bytes(canonical + b" ")
        checked = self._validate(receipt3, evidence3, "--check", os.fspath(noncanonical))
        self.assertEqual(checked.returncode, 2)

    def test_dirty_source_and_reused_output_are_rejected(self) -> None:
        (self.source / "README").write_text("dirty\n", encoding="utf-8")
        result, _, receipt = self._run(suffix="dirty")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(receipt.exists())

        subprocess.run(["git", "-C", self.source, "checkout", "--", "README"], check=True)
        first, _, _ = self._run(suffix="reuse")
        self.assertEqual(first.returncode, 0, first.stderr)
        second, _, _ = self._run(suffix="reuse")
        self.assertEqual(second.returncode, 2)

    def test_receipt_must_be_outside_evidence_and_both_outputs_outside_source(self) -> None:
        evidence = self.base / "evidence-nested-receipt"
        result = subprocess.run(
            [
                sys.executable, os.fspath(RUNNER),
                "--executable", os.fspath(self.executable),
                "--seed-corpus", os.fspath(self.seeds),
                "--dictionary", os.fspath(self.dictionary),
                "--patchy-source", os.fspath(self.source),
                "--evidence-root", os.fspath(evidence),
                "--receipt", os.fspath(evidence / "receipt.json"),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(evidence.exists())

        result = subprocess.run(
            [
                sys.executable, os.fspath(RUNNER),
                "--executable", os.fspath(self.executable),
                "--seed-corpus", os.fspath(self.seeds),
                "--dictionary", os.fspath(self.dictionary),
                "--patchy-source", os.fspath(self.source),
                "--evidence-root", os.fspath(self.source / "evidence"),
                "--receipt", os.fspath(self.base / "receipt-in-source.json"),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.source / "evidence").exists())

    def test_validator_requires_expected_source_and_distinct_roles(self) -> None:
        _, evidence, receipt = self._run(suffix="bindings")
        wrong_sha = subprocess.run(
            [
                sys.executable, os.fspath(VALIDATOR), os.fspath(receipt), os.fspath(evidence),
                "--expected-patchy-sha", "0" * 40,
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(wrong_sha.returncode, 2)

        value = json.loads(receipt.read_text(encoding="utf-8"))
        (evidence / "inputs/psd.dict").unlink()
        value["dictionary"] = value["target"]["binary"]
        receipt.write_text(json.dumps(value), encoding="utf-8")
        collision = self._validate(receipt, evidence)
        self.assertEqual(collision.returncode, 2)
        self.assertIn("distinct paths", collision.stderr)

    def test_symlink_input_and_private_locator_log_are_rejected(self) -> None:
        link = self.base / "dictionary-link"
        try:
            link.symlink_to(self.dictionary)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unavailable")
        original = self.dictionary
        self.dictionary = link
        result, _, _ = self._run(suffix="symlink")
        self.dictionary = original
        self.assertEqual(result.returncode, 2)

        leaking = self.base / "leaking"
        leaking.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "print('/Users/alice/private/file.psd', file=sys.stderr)\n"
            "print('stat::number_of_executed_units: 1000', file=sys.stderr)\n",
            encoding="utf-8",
        )
        leaking.chmod(0o700)
        result, _, receipt = self._run(leaking, "leak")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(receipt.exists())


if __name__ == "__main__":
    unittest.main()
