#!/usr/bin/env python3
"""Validate one closed, public-safe Patchy PSD campaign receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any, Iterable


RECEIPT_VERSION = 1
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_TREE_FILE_BYTES = 64 * 1024 * 1024
MAX_TREE_BYTES = 1024 * 1024 * 1024
MAX_TREE_FILES = 100_000
MAX_LOG_BYTES = 32 * 1024 * 1024
ASAN_OPTIONS = "abort_on_error=1:detect_leaks=1:symbolize=1"
UBSAN_OPTIONS = "halt_on_error=1:print_stacktrace=1"

ROOT_KEYS = {
    "receipt_version", "status", "patchy_git_sha", "patchy_dirty", "target",
    "sanitizers", "config", "dictionary", "seed_corpus", "log", "artifacts",
    "result", "failure_reasons",
}
FILE_KEYS = {"path", "sha256", "byte_size"}
TREE_KEYS = {"path", "tree_sha256", "file_count", "byte_size", "entries"}
RESULT_KEYS = {
    "exit_code", "stop_reason", "executed_units", "new_units", "crash_count",
    "timeout_count", "oom_count", "sanitizer_error_count", "finding_count",
}
CONFIG_KEYS = {
    "engine", "seed", "runs", "max_total_time_seconds", "timeout_seconds",
    "rss_limit_mb", "max_len", "jobs", "workers",
}
FAILURE_REASONS = {
    "NONZERO_EXIT", "CRASH", "TIMEOUT", "OOM", "SANITIZER_ERROR",
    "ARTIFACT_PRESENT", "RUNNER_ERROR",
}
SAFE_PATH_RE = re.compile(
    r"^[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
UNSAFE_LOG_RE = re.compile(
    rb"(?i)(?:[a-z][a-z0-9+.-]*://|(?:^|[\s\"'=])(?:/[A-Za-z0-9._-]+){2,}|"
    rb"(?:^|[\s\"'=])[A-Z]:[\\/]|authorization\s*:|password\s*[=:]|"
    rb"secret\s*[=:]|token\s*[=:]|api[_-]?key\s*[=:]|-----BEGIN)"
)
FATAL_LOG_RE = re.compile(
    rb"(?i)(?:ERROR: AddressSanitizer|SUMMARY: AddressSanitizer|LeakSanitizer|"
    rb"UndefinedBehaviorSanitizer|runtime error:|libFuzzer: deadly signal|"
    rb"libFuzzer: timeout|out[- ]of[- ]memory|fatal assertion|^\[FAIL\])",
    re.MULTILINE,
)


class CampaignValidationError(ValueError):
    """The receipt or its evidence bundle violates the v1 contract."""


def canonical_json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CampaignValidationError("duplicate JSON member")
        result[key] = value
    return result


def _regular_bytes(path: Path, maximum: int, label: str) -> bytes:
    try:
        before = path.lstat()
    except OSError as error:
        raise CampaignValidationError(f"cannot inspect {label}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise CampaignValidationError(f"{label} must be a regular non-symlink file")
    if before.st_size > maximum:
        raise CampaignValidationError(f"{label} exceeds its size limit")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CampaignValidationError(f"cannot open {label}") from error
    chunks: list[bytes] = []
    total = 0
    try:
        opened = os.fstat(descriptor)
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise CampaignValidationError(f"{label} exceeds its size limit")
            chunks.append(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
    if identity(opened) != identity(after):
        raise CampaignValidationError(f"{label} changed while read")
    return b"".join(chunks)


def file_identity(path: Path, relative: str, maximum: int = MAX_FILE_BYTES) -> dict[str, Any]:
    raw = _regular_bytes(path, maximum, relative)
    return {"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "byte_size": len(raw)}


def _safe_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) > 512 or SAFE_PATH_RE.fullmatch(value) is None:
        raise CampaignValidationError(f"{label} must be a safe relative POSIX path")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise CampaignValidationError(f"{label} must be canonical")
    return value


def _closed(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise CampaignValidationError(f"{label} does not match the closed v1 contract")
    return value


def _integer(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise CampaignValidationError(f"{label} is outside the v1 bounds")
    return value


def _tree_digest(entries: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256(b"patchy-fuzz-tree-v1\n")
    for entry in entries:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(entry["byte_size"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(entry["sha256"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _walk(base: Path, label: str) -> list[str]:
    try:
        root = base.lstat()
    except OSError as error:
        raise CampaignValidationError(f"cannot inspect {label}") from error
    if stat.S_ISLNK(root.st_mode) or not stat.S_ISDIR(root.st_mode):
        raise CampaignValidationError(f"{label} must be a non-symlink directory")
    files: list[str] = []
    for directory, names, leaves in os.walk(base, followlinks=False):
        names.sort(key=lambda name: name.encode("utf-8"))
        leaves.sort(key=lambda name: name.encode("utf-8"))
        for name in names:
            if (Path(directory) / name).is_symlink():
                raise CampaignValidationError(f"{label} contains a symlink")
        for name in leaves:
            child = Path(directory) / name
            relative = child.relative_to(base).as_posix()
            _safe_path(relative, label)
            if child.is_symlink() or not child.is_file():
                raise CampaignValidationError(f"{label} contains a non-regular entry")
            files.append(relative)
            if len(files) > MAX_TREE_FILES:
                raise CampaignValidationError(f"{label} has too many files")
    return sorted(files, key=lambda item: item.encode("utf-8"))


def tree_identity(root: Path, relative: str) -> dict[str, Any]:
    base = root / relative
    entries = [file_identity(base / path, path, MAX_TREE_FILE_BYTES) for path in _walk(base, relative)]
    total = sum(entry["byte_size"] for entry in entries)
    if total > MAX_TREE_BYTES:
        raise CampaignValidationError(f"{relative} exceeds its size limit")
    return {
        "path": relative,
        "tree_sha256": _tree_digest(entries),
        "file_count": len(entries),
        "byte_size": total,
        "entries": entries,
    }


def _validate_file(value: Any, root: Path, label: str, maximum: int = MAX_FILE_BYTES) -> bytes:
    item = _closed(value, FILE_KEYS, label)
    relative = _safe_path(item["path"], f"{label}.path")
    if not isinstance(item["sha256"], str) or SHA256_RE.fullmatch(item["sha256"]) is None:
        raise CampaignValidationError(f"{label}.sha256 is invalid")
    _integer(item["byte_size"], 0, maximum, f"{label}.byte_size")
    actual = file_identity(root / relative, relative, maximum)
    if actual != item:
        raise CampaignValidationError(f"{label} identity does not match evidence")
    return _regular_bytes(root / relative, maximum, label)


def _validate_tree(value: Any, root: Path, label: str) -> int:
    item = _closed(value, TREE_KEYS, label)
    relative = _safe_path(item["path"], f"{label}.path")
    expected = tree_identity(root, relative)
    if item != expected:
        raise CampaignValidationError(f"{label} does not match its closed evidence tree")
    return expected["file_count"]


def load_receipt(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = _regular_bytes(path, MAX_JSON_BYTES, "receipt")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CampaignValidationError("receipt is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise CampaignValidationError("receipt root must be an object")
    return value, raw


def validate_campaign(receipt: dict[str, Any], evidence_root: Path) -> None:
    root = _closed(receipt, ROOT_KEYS, "receipt")
    if root["receipt_version"] != RECEIPT_VERSION or root["status"] not in {"PASS", "FAIL"}:
        raise CampaignValidationError("receipt version or status is invalid")
    if not isinstance(root["patchy_git_sha"], str) or GIT_SHA_RE.fullmatch(root["patchy_git_sha"]) is None:
        raise CampaignValidationError("patchy_git_sha is invalid")
    if type(root["patchy_dirty"]) is not bool:
        raise CampaignValidationError("patchy_dirty must be boolean")
    target = _closed(root["target"], {"name", "binary"}, "target")
    if target["name"] != "psd_document_fuzzer":
        raise CampaignValidationError("target name is not the reviewed entry point")
    _validate_file(target["binary"], evidence_root, "target.binary")
    sanitizers = _closed(root["sanitizers"], {"enabled", "asan_options", "ubsan_options"}, "sanitizers")
    if sanitizers != {"enabled": ["address", "undefined"], "asan_options": ASAN_OPTIONS, "ubsan_options": UBSAN_OPTIONS}:
        raise CampaignValidationError("sanitizer configuration is not the reviewed v1 configuration")
    config = _closed(root["config"], CONFIG_KEYS, "config")
    if config["engine"] != "libfuzzer" or config["jobs"] != 1 or config["workers"] != 1:
        raise CampaignValidationError("campaign engine or concurrency is invalid")
    bounds = {
        "seed": (0, 4_294_967_295), "runs": (1, 1_000_000_000),
        "max_total_time_seconds": (1, 86_400), "timeout_seconds": (1, 300),
        "rss_limit_mb": (256, 32_768), "max_len": (1, 16_777_216),
    }
    for key, (minimum, maximum) in bounds.items():
        _integer(config[key], minimum, maximum, f"config.{key}")
    _validate_file(root["dictionary"], evidence_root, "dictionary")
    _validate_tree(root["seed_corpus"], evidence_root, "seed_corpus")
    log = _validate_file(root["log"], evidence_root, "log", MAX_LOG_BYTES)
    try:
        log.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CampaignValidationError("log must be UTF-8") from error
    if b"\0" in log or UNSAFE_LOG_RE.search(log):
        raise CampaignValidationError("log is not public-safe")
    artifact_count = _validate_tree(root["artifacts"], evidence_root, "artifacts")
    expected_files = {
        target["binary"]["path"], root["dictionary"]["path"], root["log"]["path"],
        *(f"{root['seed_corpus']['path']}/{entry['path']}" for entry in root["seed_corpus"]["entries"]),
        *(f"{root['artifacts']['path']}/{entry['path']}" for entry in root["artifacts"]["entries"]),
    }
    if set(_walk(evidence_root, "evidence root")) != expected_files:
        raise CampaignValidationError("receipt does not close the complete evidence root")
    result = _closed(root["result"], RESULT_KEYS, "result")
    for name in RESULT_KEYS - {"stop_reason"}:
        maximum = 255 if name == "exit_code" else 1_000_000_000_000
        _integer(result[name], 0, maximum, f"result.{name}")
    if result["stop_reason"] not in {"runs", "max_total_time", "crash", "timeout", "oom", "sanitizer", "runner_error"}:
        raise CampaignValidationError("stop_reason is invalid")
    typed = sum(result[name] for name in ("crash_count", "timeout_count", "oom_count", "sanitizer_error_count"))
    if result["finding_count"] != typed or artifact_count != result["finding_count"]:
        raise CampaignValidationError("finding counters and artifact count disagree")
    reasons = root["failure_reasons"]
    if not isinstance(reasons, list) or reasons != sorted(set(reasons)) or any(reason not in FAILURE_REASONS for reason in reasons):
        raise CampaignValidationError("failure_reasons are invalid")
    if root["status"] == "PASS":
        if root["patchy_dirty"] or result["exit_code"] or result["finding_count"] or reasons or artifact_count:
            raise CampaignValidationError("PASS requires a clean zero-finding execution")
        if result["stop_reason"] not in {"runs", "max_total_time"} or result["executed_units"] < 1 or FATAL_LOG_RE.search(log):
            raise CampaignValidationError("PASS did not reach a clean bounded stop")
        if result["stop_reason"] == "runs" and result["executed_units"] != config["runs"]:
            raise CampaignValidationError("runs stop did not execute the configured count")
    elif not reasons:
        raise CampaignValidationError("FAIL requires derived failure reasons")


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("evidence_root", type=Path)
    parser.add_argument("--check", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        receipt, _ = load_receipt(args.receipt)
        validate_campaign(receipt, args.evidence_root)
        canonical = canonical_json_bytes(receipt)
        if args.check is not None and _regular_bytes(args.check, MAX_JSON_BYTES, "--check") != canonical:
            raise CampaignValidationError("--check receipt is not canonical and byte-identical")
    except CampaignValidationError as error:
        print(f"campaign validation failed: {error}", file=sys.stderr)
        return 2
    print(receipt["status"])
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
