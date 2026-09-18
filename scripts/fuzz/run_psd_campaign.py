#!/usr/bin/env python3
"""Create one bounded, reproducible Patchy PSD campaign evidence bundle."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from typing import Any

from validate_psd_campaign import (
    ASAN_OPTIONS,
    UBSAN_OPTIONS,
    CampaignValidationError,
    canonical_json_bytes,
    file_identity,
    tree_identity,
    validate_campaign,
)


SEED = 1
RUNS = 1000
MAX_TOTAL_TIME_SECONDS = 60
TIMEOUT_SECONDS = 5
RSS_LIMIT_MB = 2048
MAX_LEN = 4 * 1024 * 1024
PROCESS_GRACE_SECONDS = 15
EXECUTED_RE = re.compile(rb"stat::number_of_executed_units:\s*([0-9]+)")
NEW_UNITS_RE = re.compile(rb"stat::new_units_added:\s*([0-9]+)")


def _copy_file(source: Path, destination: Path, *, executable: bool = False) -> None:
    source_meta = source.lstat()
    if stat.S_ISLNK(source_meta.st_mode) or not stat.S_ISREG(source_meta.st_mode):
        raise CampaignValidationError("campaign inputs must be regular non-symlink files")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as reader, destination.open("xb") as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)
    if executable:
        destination.chmod(0o700)


def _copy_seed_tree(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise CampaignValidationError("seed corpus must be a non-symlink directory")
    destination.mkdir()
    count = 0
    for item in sorted(source.rglob("*"), key=lambda path: path.relative_to(source).as_posix().encode("utf-8")):
        relative = item.relative_to(source)
        if item.is_symlink():
            raise CampaignValidationError("seed corpus contains a symlink")
        if item.is_dir():
            (destination / relative).mkdir(exist_ok=True)
        elif item.is_file():
            _copy_file(item, destination / relative)
            count += 1
        else:
            raise CampaignValidationError("seed corpus contains a non-regular entry")
    if count == 0:
        raise CampaignValidationError("seed corpus must not be empty")


def _git_identity(source: Path) -> tuple[str, bool]:
    def git(*arguments: str) -> str:
        result = subprocess.run(
            ["git", "-C", os.fspath(source), *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise CampaignValidationError("could not resolve Patchy Git identity")
        return result.stdout.strip()

    revision = git("rev-parse", "HEAD")
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise CampaignValidationError("Patchy HEAD is not a full Git SHA")
    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    return revision, dirty


def _arguments() -> list[str]:
    return [
        f"-runs={RUNS}", f"-seed={SEED}", f"-max_total_time={MAX_TOTAL_TIME_SECONDS}",
        f"-timeout={TIMEOUT_SECONDS}", f"-rss_limit_mb={RSS_LIMIT_MB}",
        f"-max_len={MAX_LEN}", "-print_final_stats=1",
        "-artifact_prefix=artifacts/", "-dict=inputs/psd.dict", "work/corpus", "seed",
    ]


def _last_counter(pattern: re.Pattern[bytes], log: bytes) -> int | None:
    matches = pattern.findall(log)
    return int(matches[-1]) if matches else None


def _result(return_code: int, timed_out: bool, log: bytes, artifact_count: int) -> tuple[str, dict[str, Any], list[str]]:
    executed = _last_counter(EXECUTED_RE, log)
    new_units = _last_counter(NEW_UNITS_RE, log) or 0
    reasons: set[str] = set()
    crash = timeout = oom = sanitizer = 0
    stop_reason = "runner_error"
    if timed_out or b"libFuzzer: timeout" in log:
        timeout = artifact_count or 1
        stop_reason = "timeout"
        reasons.add("TIMEOUT")
    elif b"out-of-memory" in log or b"allocator is out of memory" in log:
        oom = artifact_count or 1
        stop_reason = "oom"
        reasons.add("OOM")
    elif b"AddressSanitizer" in log or b"UndefinedBehaviorSanitizer" in log or b"runtime error:" in log:
        sanitizer = artifact_count or 1
        stop_reason = "sanitizer"
        reasons.add("SANITIZER_ERROR")
    elif b"libFuzzer: deadly signal" in log or artifact_count:
        crash = artifact_count or 1
        stop_reason = "crash"
        reasons.add("CRASH")
    elif return_code == 0 and executed is not None:
        stop_reason = "runs" if executed == RUNS else "max_total_time"
    else:
        reasons.add("RUNNER_ERROR")
    finding_count = crash + timeout + oom + sanitizer
    if return_code:
        reasons.add("NONZERO_EXIT")
    if artifact_count:
        reasons.add("ARTIFACT_PRESENT")
    if stop_reason == "runner_error":
        reasons.add("RUNNER_ERROR")
    status = "PASS" if return_code == 0 and finding_count == 0 and executed is not None else "FAIL"
    return status, {
        "exit_code": return_code,
        "stop_reason": stop_reason,
        "executed_units": executed or 0,
        "new_units": min(new_units, executed or 0),
        "crash_count": crash,
        "timeout_count": timeout,
        "oom_count": oom,
        "sanitizer_error_count": sanitizer,
        "finding_count": finding_count,
    }, sorted(reasons)


def run_campaign(executable: Path, seed_source: Path, dictionary: Path, patchy_source: Path,
                 evidence_root: Path, receipt_path: Path) -> dict[str, Any]:
    if os.path.lexists(evidence_root) or os.path.lexists(receipt_path):
        raise CampaignValidationError("evidence root and receipt must be new paths")
    try:
        evidence_location = evidence_root.resolve(strict=False)
        receipt_location = receipt_path.resolve(strict=False)
        source_location = patchy_source.resolve(strict=True)
    except OSError as error:
        raise CampaignValidationError("could not resolve campaign output/source locations") from error
    try:
        receipt_location.relative_to(evidence_location)
    except ValueError:
        pass
    else:
        raise CampaignValidationError("receipt must be outside the closed evidence root")
    for output_location in (evidence_location, receipt_location):
        try:
            output_location.relative_to(source_location)
        except ValueError:
            continue
        raise CampaignValidationError("campaign evidence and receipt must be outside the Patchy worktree")
    revision, dirty = _git_identity(patchy_source)
    if dirty:
        raise CampaignValidationError("Patchy source must be clean before an evidence run")
    evidence_root.mkdir()
    for relative in ("bin", "inputs", "logs", "artifacts", "work/corpus"):
        (evidence_root / relative).mkdir(parents=True)
    _copy_file(executable, evidence_root / "bin/patchy_psd_fuzzer", executable=True)
    _copy_file(dictionary, evidence_root / "inputs/psd.dict")
    _copy_seed_tree(seed_source, evidence_root / "seed")

    environment = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C", "LC_ALL": "C",
        "ASAN_OPTIONS": ASAN_OPTIONS, "UBSAN_OPTIONS": UBSAN_OPTIONS,
    }
    command = ["bin/patchy_psd_fuzzer", *_arguments()]
    timed_out = False
    try:
        completed = subprocess.run(
            command, cwd=evidence_root, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=MAX_TOTAL_TIME_SECONDS + TIMEOUT_SECONDS + PROCESS_GRACE_SECONDS,
            check=False,
        )
        return_code = completed.returncode if 0 <= completed.returncode <= 255 else 255
        log = completed.stdout
    except subprocess.TimeoutExpired as error:
        timed_out = True
        return_code = 124
        log = (error.stdout or b"") + b"\nrunner timeout after bounded campaign window\n"
    (evidence_root / "logs/fuzz.log").write_bytes(log)
    shutil.rmtree(evidence_root / "work")
    artifact_paths = list((evidence_root / "artifacts").iterdir())
    finding_without_artifact = (
        timed_out
        or b"libFuzzer: timeout" in log
        or b"out-of-memory" in log
        or b"allocator is out of memory" in log
        or b"AddressSanitizer" in log
        or b"UndefinedBehaviorSanitizer" in log
        or b"runtime error:" in log
        or b"libFuzzer: deadly signal" in log
    )
    if finding_without_artifact and not artifact_paths:
        (evidence_root / "artifacts/finding-0001.txt").write_text(
            "bounded campaign finding; see the hash-bound public log\n",
            encoding="utf-8",
        )
    artifacts = tree_identity(evidence_root, "artifacts")
    status, result, reasons = _result(return_code, timed_out, log, artifacts["file_count"])
    receipt = {
        "receipt_version": 1,
        "status": status,
        "patchy_git_sha": revision,
        "patchy_dirty": dirty,
        "target": {"name": "psd_document_fuzzer", "binary": file_identity(evidence_root / "bin/patchy_psd_fuzzer", "bin/patchy_psd_fuzzer")},
        "sanitizers": {"enabled": ["address", "undefined"], "asan_options": ASAN_OPTIONS, "ubsan_options": UBSAN_OPTIONS},
        "config": {
            "engine": "libfuzzer", "seed": SEED, "runs": RUNS,
            "max_total_time_seconds": MAX_TOTAL_TIME_SECONDS, "timeout_seconds": TIMEOUT_SECONDS,
            "rss_limit_mb": RSS_LIMIT_MB, "max_len": MAX_LEN, "jobs": 1, "workers": 1,
        },
        "dictionary": file_identity(evidence_root / "inputs/psd.dict", "inputs/psd.dict"),
        "seed_corpus": tree_identity(evidence_root, "seed"),
        "log": file_identity(evidence_root / "logs/fuzz.log", "logs/fuzz.log"),
        "artifacts": artifacts,
        "result": result,
        "failure_reasons": reasons,
    }
    validate_campaign(receipt, evidence_root, revision)
    receipt_path.write_bytes(canonical_json_bytes(receipt))
    return receipt


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--seed-corpus", type=Path, required=True)
    parser.add_argument("--dictionary", type=Path, required=True)
    parser.add_argument("--patchy-source", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        receipt = run_campaign(args.executable, args.seed_corpus, args.dictionary,
                               args.patchy_source, args.evidence_root, args.receipt)
    except (CampaignValidationError, OSError, subprocess.SubprocessError) as error:
        print(f"campaign failed: {error}", file=sys.stderr)
        return 2
    print(receipt["status"])
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
