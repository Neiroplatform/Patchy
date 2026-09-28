#!/usr/bin/env python3
"""Generate the closed compliance payload for the Qt-free self-hosted SDK.

The generator consumes the exact wasm-ld map emitted beside patchy-engine.wasm,
maps every contributing object/archive member to an allowlisted component, and
stages a deterministic CycloneDX SBOM plus the applicable license texts.  It
also closes the machine census of every linked preset object and item into an
owner-review packet.  It does not make a legal-clearance decision: absent
external owner attestation keeps the distribution state BLOCKED.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import uuid
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
EXPECTED_EMSCRIPTEN_VERSION = "4.0.7"
MAP_HEADER = "    Addr      Off     Size Out     In      Symbol"
MAP_INPUT_RE = re.compile(
    r"^\s*(?:-|[0-9a-f]+)\s+(?:-|[0-9a-f]+)\s+[0-9a-f]+\s{9}(\S.*)$",
    re.IGNORECASE,
)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
PRESET_PLAN_RELATIVE = "compliance/self-hosted-preset-provenance-plan.json"
PRESET_PLAN_SCHEMA = "patchy.self-hosted-preset-provenance-plan/v1"
PRESET_OUTPUT_SCHEMA = "patchy.self-hosted-preset-provenance/v1"
PRESET_FAMILIES = ("contour", "pattern", "style")
PRESET_SOURCE_BY_MEMBER = {
    "contour_presets.cpp.o": "src/core/contour_presets.cpp",
    "pattern_presets.cpp.o": "src/core/pattern_presets.cpp",
    "style_presets.cpp.o": "src/core/style_presets.cpp",
}
CONTOUR_PRESET_RE = re.compile(
    r'\{"(contour\.[a-z0-9_]+)",\s*PATCHY_TRANSLATE_NOOP\("QObject",\s*"([^"]+)"\)',
    re.MULTILINE,
)
PATTERN_PRESET_RE = re.compile(
    r'\{"(c4a11e00-[0-9a-f-]+)",\s*PATCHY_TRANSLATE_NOOP\("QObject",\s*"([^"]+)"\)\}',
    re.MULTILINE,
)
STYLE_FOLDER_RE = re.compile(
    r'constexpr const char\* (k[A-Za-z]+Folder) = PATCHY_TRANSLATE_NOOP\("QObject",\s*"([^"]+)"\);'
)
STYLE_PRESET_RE = re.compile(
    r'\{\{"(57a1e500-[0-9a-f-]+)",\s*PATCHY_TRANSLATE_NOOP\("QObject",\s*"([^"]+)"\),'
    r'\s*(k[A-Za-z]+Folder),\s*(\d+)\}',
    re.MULTILINE,
)
PHOTO_PATTERN_REFERENCE_RE = re.compile(r'"(f0705a00-[0-9a-f-]+)"')
FORBIDDEN_INPUT_FRAGMENTS = (
    "libheif",
    "libpatchy_libraw",
    "af_document_io",
    "stb_image",
    "zstd",
    "qt6",
    "/qt/",
)
PATCHY_ARCHIVES = {
    "libpatchy_color.a",
    "libpatchy_core.a",
    "libpatchy_engine.a",
    "libpatchy_filters.a",
    "libpatchy_formats.a",
    "libpatchy_lcms2.a",
    "libpatchy_psd.a",
    "libpatchy_render.a",
}
EMSCRIPTEN_ARCHIVE_COMPONENTS = {
    "libc-mt.a": "musl",
    "libc++-mt-legacyexcept.a": "libcxx",
    "libc++abi-mt-legacyexcept.a": "libcxxabi",
    "libcompiler_rt-legacysjlj-mt.a": "compiler-rt",
    "libdlmalloc-mt.a": "dlmalloc",
    "libnoexit.a": "emscripten",
    "libstubs.a": "emscripten",
    "libunwind-mt-legacyexcept.a": "libunwind",
}
COMPONENT_ORDER = (
    "patchy",
    "patchy-presets",
    "little-cms",
    "miniz",
    "emscripten",
    "musl",
    "libcxx",
    "libcxxabi",
    "compiler-rt",
    "libunwind",
    "dlmalloc",
)


class VerificationError(RuntimeError):
    """An input or generated compliance boundary is incomplete or unsafe."""


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_regular(path: Path, *, label: str, maximum: int = 64 * 1024 * 1024) -> bytes:
    try:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise VerificationError(f"{label} must be a regular non-symlink file")
        data = path.read_bytes()
        after = path.stat()
    except OSError as error:
        raise VerificationError(f"cannot read {label}: {error}") from error
    if not data or len(data) > maximum:
        raise VerificationError(f"{label} must be non-empty and at most {maximum} bytes")
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise VerificationError(f"{label} changed while reading")
    return data


def require_real_directory(path: Path, *, label: str) -> Path:
    path = path.resolve()
    try:
        info = path.lstat()
    except OSError as error:
        raise VerificationError(f"cannot inspect {label}: {error}") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise VerificationError(f"{label} must be a real directory")
    return path


def safe_relative(value: str, *, label: str) -> str:
    value = value.replace("\\", "/")
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or path.as_posix() != value
        or any(part in {"", ".", ".."} for part in path.parts)
        or ":" in path.parts[0]
    ):
        raise VerificationError(f"{label} must be a normalized relative path: {value!r}")
    return value


def normalize_absolute(path: str, *, roots: dict[str, Path]) -> str:
    normalized = path.replace("\\", "/")
    matches: list[tuple[int, str]] = []
    for token, root in roots.items():
        root_text = root.as_posix().rstrip("/")
        if normalized == root_text:
            matches.append((len(root_text), f"${{{token}}}"))
        elif normalized.startswith(root_text + "/"):
            suffix = safe_relative(normalized[len(root_text) + 1 :], label="map suffix")
            matches.append((len(root_text), f"${{{token}}}/{suffix}"))
    if not matches:
        raise VerificationError(f"link input is outside the build/Emscripten roots: {path}")
    return sorted(matches, key=lambda item: (-item[0], item[1]))[0][1]


def parse_map(data: bytes, *, build_root: Path, emscripten_root: Path) -> list[dict[str, str | None]]:
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise VerificationError(f"link map is not UTF-8: {error}") from error
    if not lines or lines[0] != MAP_HEADER:
        raise VerificationError("unsupported wasm-ld map header")
    roots = {"BUILD_ROOT": build_root, "EMSCRIPTEN_ROOT": emscripten_root}
    records: set[tuple[str, str | None]] = set()
    saw_internal = False
    for number, line in enumerate(lines[1:], 2):
        match = MAP_INPUT_RE.match(line)
        if not match:
            continue
        candidate = match.group(1)
        marker = candidate.find(":(")
        if marker <= 0 or not candidate.endswith(")"):
            if any(fragment in candidate for fragment in ("/", "\\", ".o", ".a(")):
                raise VerificationError(f"malformed map input at line {number}")
            continue
        source = candidate[:marker]
        if source == "<internal>":
            saw_internal = True
            continue
        member: str | None = None
        if source.endswith(")") and "(" in source:
            archive, member = source.rsplit("(", 1)
            member = safe_relative(member[:-1].replace("\\", "/"), label="archive member")
            source = archive
            if not source.lower().endswith(".a"):
                raise VerificationError(f"unsupported archive input at line {number}")
        elif not source.lower().endswith(".o"):
            raise VerificationError(f"unsupported object input at line {number}")
        if os.path.isabs(source) or re.match(r"^[A-Za-z]:[/\\]", source):
            source = normalize_absolute(source, roots=roots)
        else:
            source = safe_relative(source.replace("\\", "/"), label="link input")
        records.add((source, member))
    if not saw_internal or not records:
        raise VerificationError("link map lacks internal or contributing-input records")
    return [
        {"path": path, "archive_member": member}
        for path, member in sorted(records, key=lambda item: (item[0], item[1] or ""))
    ]


def classify(inputs: list[dict[str, str | None]]) -> tuple[dict[str, list[dict[str, str | None]]], list[str]]:
    grouped = {name: [] for name in COMPONENT_ORDER}
    for record in inputs:
        path = str(record["path"])
        member = record["archive_member"]
        folded = f"{path}({member or ''})".casefold()
        if any(fragment in folded for fragment in FORBIDDEN_INPUT_FRAGMENTS):
            raise VerificationError(f"forbidden/excluded component entered the SDK link: {folded}")
        name = PurePosixPath(path).name
        if path.startswith("${EMSCRIPTEN_ROOT}/"):
            if member is None and name == "crtbegin.o":
                component = "emscripten"
            else:
                component = EMSCRIPTEN_ARCHIVE_COMPONENTS.get(name)
            if component is None:
                raise VerificationError(f"unknown Emscripten runtime input: {path}")
        elif name in PATCHY_ARCHIVES:
            if member is None:
                raise VerificationError(f"Patchy archive record lacks a member: {path}")
            if name == "libpatchy_lcms2.a":
                component = "little-cms"
            elif name == "libpatchy_psd.a" and member == "miniz.c.o":
                component = "miniz"
            elif name == "libpatchy_core.a" and member.endswith("_presets.cpp.o"):
                if member not in PRESET_SOURCE_BY_MEMBER:
                    raise VerificationError(f"unknown compiled preset object: {member}")
                component = "patchy-presets"
            else:
                component = "patchy"
        elif path == "CMakeFiles/patchy_engine_wasm_sdk.dir/src/engine/wasm_sdk_main.cpp.o" and member is None:
            component = "patchy"
        else:
            raise VerificationError(f"unknown self-hosted SDK link input: {path}")
        grouped[component].append(record)
    empty = [name for name, records in grouped.items() if not records]
    if empty:
        raise VerificationError(f"expected runtime component has no contributing inputs: {', '.join(empty)}")
    exclusions = [
        "Qt for WebAssembly",
        "libheif",
        "LibRaw",
        "afread-derived importer",
        "stb_image",
        "Zstandard decompressor",
        "fonts",
        "icons",
        "textures",
        "translations",
        "test fixtures",
        "desktop agent kit",
    ]
    return grouped, exclusions


def load_preset_plan(source_root: Path) -> tuple[dict[str, object], bytes]:
    plan_path = source_root / PRESET_PLAN_RELATIVE
    plan_bytes = read_regular(plan_path, label="preset provenance plan", maximum=1024 * 1024)
    try:
        plan = json.loads(plan_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"preset provenance plan is not valid UTF-8 JSON: {error}") from error
    if not isinstance(plan, dict) or set(plan) != {
        "schema",
        "evidenceBoundary",
        "families",
        "expectedRecipeOnlyAssetReferences",
        "ownerAttestation",
    }:
        raise VerificationError("preset provenance plan has an unsupported root contract")
    if plan["schema"] != PRESET_PLAN_SCHEMA or plan["evidenceBoundary"] != "compiled-link-input-census":
        raise VerificationError("preset provenance plan schema or evidence boundary is unsupported")
    families = plan["families"]
    if (
        not isinstance(families, list)
        or not all(isinstance(item, dict) for item in families)
        or [item.get("family") for item in families] != list(PRESET_FAMILIES)
    ):
        raise VerificationError("preset provenance plan must declare contour, pattern, style in order")
    all_ids: list[str] = []
    for item in families:
        if set(item) != {"archiveMember", "expectedIds", "family", "sourcePath"}:
            raise VerificationError("preset provenance family has an unsupported contract")
        member = item["archiveMember"]
        family = item["family"]
        if not isinstance(member, str) or not isinstance(family, str):
            raise VerificationError("preset provenance family and archive member must be strings")
        if not isinstance(item["sourcePath"], str):
            raise VerificationError(f"preset family {family} sourcePath must be a string")
        source_path = safe_relative(item["sourcePath"], label="preset source path")
        if member not in PRESET_SOURCE_BY_MEMBER or PRESET_SOURCE_BY_MEMBER[member] != source_path:
            raise VerificationError(f"preset family {family} has an unsupported source/object binding")
        expected_ids = item["expectedIds"]
        if not isinstance(expected_ids, list) or not expected_ids or not all(isinstance(value, str) and value for value in expected_ids):
            raise VerificationError(f"preset family {family} expectedIds must be non-empty strings")
        if len(set(expected_ids)) != len(expected_ids):
            raise VerificationError(f"preset family {family} repeats an id")
        all_ids.extend(expected_ids)
    if len(set(all_ids)) != len(all_ids):
        raise VerificationError("preset provenance plan repeats an id across families")
    asset_refs = plan["expectedRecipeOnlyAssetReferences"]
    if (
        not isinstance(asset_refs, list)
        or not all(isinstance(value, str) and value for value in asset_refs)
        or asset_refs != sorted(set(asset_refs))
    ):
        raise VerificationError("preset recipe-only asset references must be unique and sorted")
    attestation = plan["ownerAttestation"]
    if attestation != {
        "decision": None,
        "reviewedAt": None,
        "reviewer": None,
        "status": "pending_external_owner_attestation",
    }:
        raise VerificationError("preset provenance plan may not invent an owner attestation")
    return plan, plan_bytes


def extract_preset_items(family: str, data: bytes) -> list[dict[str, object]]:
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise VerificationError(f"{family} preset source is not UTF-8: {error}") from error
    if family == "contour":
        rows = CONTOUR_PRESET_RE.findall(source)
        return [{"family": family, "id": preset_id, "name": name} for preset_id, name in rows]
    if family == "pattern":
        rows = PATTERN_PRESET_RE.findall(source)
        return [{"family": family, "id": preset_id, "name": name} for preset_id, name in rows]
    if family == "style":
        folders = dict(STYLE_FOLDER_RE.findall(source))
        rows = STYLE_PRESET_RE.findall(source)
        if any(folder not in folders for _, _, folder, _ in rows):
            raise VerificationError("style preset references an unknown canonical folder")
        return [
            {
                "family": family,
                "id": preset_id,
                "name": name,
                "folder": folders[folder],
                "introducedVersion": int(version),
            }
            for preset_id, name, folder, version in rows
        ]
    raise VerificationError(f"unsupported preset family: {family}")


def build_preset_provenance(
    *,
    source_root: Path,
    source_sha: str,
    grouped: dict[str, list[dict[str, str | None]]],
) -> dict[str, object]:
    plan, plan_bytes = load_preset_plan(source_root)
    linked = grouped["patchy-presets"]
    actual_members = []
    for record in linked:
        if PurePosixPath(str(record["path"])).name != "libpatchy_core.a" or record["archive_member"] is None:
            raise VerificationError("preset component contains a non-core or non-archive input")
        actual_members.append(str(record["archive_member"]))
    expected_members = [str(item["archiveMember"]) for item in plan["families"]]
    if sorted(actual_members) != sorted(expected_members):
        raise VerificationError("linked preset objects differ from the provenance plan")

    source_records: list[dict[str, object]] = []
    items: list[dict[str, object]] = []
    source_text: dict[str, str] = {}
    for family_plan in plan["families"]:
        family = str(family_plan["family"])
        source_path = str(family_plan["sourcePath"])
        source_data = read_regular(source_root / source_path, label=f"{family} preset source")
        extracted = extract_preset_items(family, source_data)
        actual_ids = [str(item["id"]) for item in extracted]
        if actual_ids != family_plan["expectedIds"]:
            raise VerificationError(f"{family} preset ids differ from the reviewed provenance plan")
        for item in extracted:
            item["sourcePath"] = source_path
            item["rightsState"] = "pending_external_owner_attestation"
        items.extend(extracted)
        source_records.append(
            {
                "archiveMember": family_plan["archiveMember"],
                "sourcePath": source_path,
                "bytes": len(source_data),
                "sha256": sha256(source_data),
                "itemCount": len(extracted),
            }
        )
        source_text[family] = source_data.decode("utf-8")

    if len({str(item["id"]) for item in items}) != len(items):
        raise VerificationError("extracted preset ids are not globally unique")
    actual_asset_refs = sorted(set(PHOTO_PATTERN_REFERENCE_RE.findall(source_text["style"])))
    if actual_asset_refs != plan["expectedRecipeOnlyAssetReferences"]:
        raise VerificationError("style recipe-only asset references differ from the provenance plan")
    return {
        "schema": PRESET_OUTPUT_SCHEMA,
        "sourceSha": source_sha,
        "planSha256": sha256(plan_bytes),
        "evidenceBoundary": "compiled-link-input-census",
        "status": "READY_FOR_OWNER_ATTESTATION",
        "distributionGate": "BLOCKED",
        "linkedObjects": source_records,
        "itemCount": len(items),
        "items": items,
        "recipeOnlyAssetReferences": [
            {
                "id": preset_id,
                "relationship": "style-recipe-reference-only",
                "assetBytesInArtifact": False,
            }
            for preset_id in actual_asset_refs
        ],
        "ownerAttestation": plan["ownerAttestation"],
        "nonClaims": [
            "Git history, source comments and this census are not an ownership or assignment attestation.",
            "Recipe-only asset references do not assert that the corresponding texture bytes ship in this artifact.",
            "READY_FOR_OWNER_ATTESTATION is not distribution clearance.",
        ],
    }


def inventory_site(site_root: Path) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    for path in sorted(site_root.rglob("*")):
        relative = path.relative_to(site_root).as_posix()
        if relative == "legal" or relative.startswith("legal/"):
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise VerificationError(f"staged site contains a symlink: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise VerificationError(f"unsupported staged-site entry: {relative}")
        data = read_regular(path, label=f"staged site file {relative}")
        files.append({"path": safe_relative(relative, label="staged path"), "bytes": len(data), "sha256": sha256(data)})
    required = {"patchy-engine.mjs", "patchy-engine.wasm", "patchy.html", "capabilities.html", "legal.html"}
    actual = {str(item["path"]) for item in files}
    missing = sorted(required - actual)
    if missing:
        raise VerificationError(f"staged site lacks compliance-required files: {', '.join(missing)}")
    return files


def license(expression: str | None) -> list[dict[str, object]]:
    return [{"license": {"name": "NOASSERTION"}}] if expression is None else [{"expression": expression}]


def component(
    slug: str,
    name: str,
    version: str,
    expression: str | None,
    notice: str,
    inputs: list[dict[str, str | None]],
    *,
    unresolved: str = "none",
    extra_properties: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    return {
        "bom-ref": f"patchy-self-hosted:{slug}@{version}",
        "type": "data" if slug == "patchy-presets" else "library",
        "name": name,
        "version": version,
        "licenses": license(expression),
        "properties": [
            {"name": "patchy:artifact:input-count", "value": str(len(inputs))},
            {"name": "patchy:artifact:link-inputs", "value": json.dumps(inputs, separators=(",", ":"), sort_keys=True)},
            {"name": "patchy:artifact:notice-path", "value": notice},
            {"name": "patchy:artifact:unresolved", "value": unresolved},
        ] + list(extra_properties or []),
    }


def build_sbom(
    *,
    source_sha: str,
    map_sha: str,
    input_manifest_sha: str,
    grouped: dict[str, list[dict[str, str | None]]],
    site_files: list[dict[str, object]],
    exclusions: list[str],
    preset_provenance: dict[str, object],
    preset_provenance_sha: str,
) -> dict[str, object]:
    specs = {
        "patchy": ("Patchy Qt-free self-hosted engine", "0.94", "MIT", "legal/licenses/PATCHY-LICENSE.txt", "none"),
        "patchy-presets": (
            "Compiled Patchy presets",
            source_sha,
            None,
            "legal/licenses/PATCHY-NOTICE-THIRD-PARTY.txt",
            "external-owner-attestation-not-recorded",
        ),
        "little-cms": ("Little CMS core", "2.17", "MIT", "legal/licenses/little-cms-LICENSE.txt", "exact-upstream-revision-and-archive-digest-not-recorded"),
        "miniz": ("miniz", "3.0.2", "MIT", "legal/licenses/miniz-LICENSE.txt", "source-banner-declares-3.0.0-while-project-notice-declares-3.0.2"),
        "emscripten": ("Emscripten generated runtime", EXPECTED_EMSCRIPTEN_VERSION, "MIT OR NCSA", "legal/licenses/emscripten-LICENSE.txt", "none"),
        "musl": ("musl libc runtime subset", "1.2.x-emscripten", "MIT", "legal/licenses/musl-COPYRIGHT.txt", "exact-upstream-musl-revision-is-inherited-from-emscripten-4.0.7"),
        "libcxx": ("LLVM libc++ runtime subset", "21.0.0", "Apache-2.0 WITH LLVM-exception", "legal/licenses/libcxx-LICENSE.txt", "none"),
        "libcxxabi": ("LLVM libc++abi runtime subset", "21.0.0", "Apache-2.0 WITH LLVM-exception", "legal/licenses/libcxxabi-LICENSE.txt", "none"),
        "compiler-rt": ("LLVM compiler-rt runtime subset", "21.0.0", "Apache-2.0 WITH LLVM-exception", "legal/licenses/compiler-rt-LICENSE.txt", "none"),
        "libunwind": ("LLVM libunwind runtime subset", "21.0.0", "Apache-2.0 WITH LLVM-exception", "legal/licenses/libunwind-LICENSE.txt", "none"),
        "dlmalloc": ("dlmalloc", "2.8.6", "CC0-1.0", "legal/licenses/dlmalloc.c", "upstream-declaration-states-public-domain"),
    }
    components = []
    for slug in COMPONENT_ORDER:
        name, version, expression, notice, unresolved = specs[slug]
        components.append(
            component(
                slug,
                name,
                version,
                expression,
                notice,
                grouped[slug],
                unresolved=unresolved,
                extra_properties=(
                    [
                        {"name": "patchy:artifact:preset-provenance-path", "value": "legal/preset-provenance.json"},
                        {"name": "patchy:artifact:preset-provenance-sha256", "value": preset_provenance_sha},
                        {"name": "patchy:artifact:preset-count", "value": str(preset_provenance["itemCount"])},
                        {
                            "name": "patchy:artifact:preset-owner-attestation",
                            "value": str(preset_provenance["ownerAttestation"]["status"]),
                        },
                    ]
                    if slug == "patchy-presets"
                    else []
                ),
            )
        )
    root_ref = f"patchy-self-hosted:release@{source_sha}"
    serial_seed = f"patchy-self-hosted-artifact:{source_sha}:{map_sha}:{input_manifest_sha}"
    return {
        "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, serial_seed)}",
        "version": 1,
        "metadata": {
            "component": {
                "bom-ref": root_ref,
                "type": "application",
                "name": "Patchy self-hosted Worker editor",
                "version": source_sha,
                "licenses": license("MIT"),
                "properties": [
                    {"name": "patchy:artifact:closure", "value": "complete-for-linked-and-staged-inputs"},
                    {"name": "patchy:artifact:distribution-gate", "value": "BLOCKED"},
                    {"name": "patchy:artifact:emscripten-version", "value": EXPECTED_EMSCRIPTEN_VERSION},
                    {"name": "patchy:artifact:excluded-components", "value": json.dumps(exclusions, separators=(",", ":"))},
                    {"name": "patchy:artifact:link-map-sha256", "value": map_sha},
                    {"name": "patchy:artifact:link-input-manifest-sha256", "value": input_manifest_sha},
                    {"name": "patchy:artifact:staged-files", "value": json.dumps(site_files, separators=(",", ":"), sort_keys=True)},
                ],
            },
            "properties": [
                {"name": "patchy:artifact:non-claim", "value": "component closure is not legal clearance"},
                {"name": "patchy:artifact:blocker", "value": "compiled preset provenance and durable source retention require external evidence"},
            ],
        },
        "components": components,
        "dependencies": [{"ref": root_ref, "dependsOn": [item["bom-ref"] for item in components]}],
        "compositions": [{"aggregate": "complete", "assemblies": [root_ref]}],
    }


def copy_licenses(source_root: Path, emscripten_root: Path, destination: Path) -> list[dict[str, object]]:
    mappings = {
        "PATCHY-LICENSE.txt": source_root / "LICENSE",
        "PATCHY-NOTICE-THIRD-PARTY.txt": source_root / "NOTICE-THIRD-PARTY.md",
        "little-cms-LICENSE.txt": source_root / "src/color/lcms2/LICENSE",
        "miniz-LICENSE.txt": source_root / "src/formats/miniz/LICENSE",
        "emscripten-LICENSE.txt": emscripten_root / "LICENSE",
        "musl-COPYRIGHT.txt": emscripten_root / "system/lib/libc/musl/COPYRIGHT",
        "libcxx-LICENSE.txt": emscripten_root / "system/lib/libcxx/LICENSE.TXT",
        "libcxxabi-LICENSE.txt": emscripten_root / "system/lib/libcxxabi/LICENSE.TXT",
        "compiler-rt-LICENSE.txt": emscripten_root / "system/lib/compiler-rt/LICENSE.TXT",
        "libunwind-LICENSE.txt": emscripten_root / "system/lib/libunwind/LICENSE.TXT",
        "dlmalloc.c": emscripten_root / "system/lib/dlmalloc.c",
    }
    destination.mkdir(parents=True)
    records = []
    for name, source in sorted(mappings.items()):
        data = read_regular(source, label=f"license source {name}", maximum=2 * 1024 * 1024)
        target = destination / name
        target.write_bytes(data)
        records.append({"path": f"legal/licenses/{name}", "bytes": len(data), "sha256": sha256(data)})
    return records


def write_payload(
    *,
    source_root: Path,
    build_root: Path,
    emscripten_root: Path,
    site_root: Path,
    map_path: Path,
    source_sha: str,
) -> dict[str, object]:
    if not SHA_RE.fullmatch(source_sha):
        raise VerificationError("source SHA must be 40 lowercase hexadecimal characters")
    version = read_regular(emscripten_root / "emscripten-version.txt", label="Emscripten version", maximum=128).decode().strip().strip('"')
    if version != EXPECTED_EMSCRIPTEN_VERSION:
        raise VerificationError(f"expected Emscripten {EXPECTED_EMSCRIPTEN_VERSION}, got {version}")
    map_data = read_regular(map_path, label="wasm-ld map")
    inputs = parse_map(map_data, build_root=build_root, emscripten_root=emscripten_root)
    grouped, exclusions = classify(inputs)
    site_files = inventory_site(site_root)
    preset_provenance = build_preset_provenance(
        source_root=source_root,
        source_sha=source_sha,
        grouped=grouped,
    )
    preset_bytes = canonical_bytes(preset_provenance)

    legal_root = site_root / "legal"
    if legal_root.exists() or legal_root.is_symlink():
        info = legal_root.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise VerificationError("existing legal payload must be a real directory")
        shutil.rmtree(legal_root)
    legal_root.mkdir()

    input_manifest = {
        "schema": "patchy.self-hosted-link-inputs/v1",
        "sourceSha": source_sha,
        "emscriptenVersion": version,
        "rawMapSha256": sha256(map_data),
        "inputs": inputs,
        "componentInputCounts": {name: len(grouped[name]) for name in COMPONENT_ORDER},
        "excludedComponents": exclusions,
    }
    input_bytes = canonical_bytes(input_manifest)
    (legal_root / "link-inputs.json").write_bytes(input_bytes)
    (legal_root / "preset-provenance.json").write_bytes(preset_bytes)
    licenses = copy_licenses(source_root, emscripten_root, legal_root / "licenses")
    source_record = {
        "schema": "patchy.self-hosted-source/v1",
        "repository": "https://github.com/Neiroplatform/Patchy",
        "commit": source_sha,
        "tree": f"https://github.com/Neiroplatform/Patchy/tree/{source_sha}",
        "archive": f"https://github.com/Neiroplatform/Patchy/archive/{source_sha}.tar.gz",
        "publication": "organization_repository_exact_commit",
        "durableRetention": "not_guaranteed_by_this_artifact",
        "distributionGate": "BLOCKED",
        "nonClaims": [
            "This record does not promise public availability for a particular retention period.",
            "This record is not a legal opinion or distribution clearance.",
        ],
    }
    (legal_root / "source.json").write_bytes(canonical_bytes(source_record))
    sbom = build_sbom(
        source_sha=source_sha,
        map_sha=sha256(map_data),
        input_manifest_sha=sha256(input_bytes),
        grouped=grouped,
        site_files=site_files,
        exclusions=exclusions,
        preset_provenance=preset_provenance,
        preset_provenance_sha=sha256(preset_bytes),
    )
    sbom_bytes = canonical_bytes(sbom)
    (legal_root / "artifact-sbom.cdx.json").write_bytes(sbom_bytes)
    notice_index = {
        "schema": "patchy.self-hosted-notices/v1",
        "sourceSha": source_sha,
        "artifactSbomSha256": sha256(sbom_bytes),
        "linkInputsSha256": sha256(input_bytes),
        "presetProvenance": {
            "path": "legal/preset-provenance.json",
            "sha256": sha256(preset_bytes),
            "status": preset_provenance["status"],
            "itemCount": preset_provenance["itemCount"],
            "ownerAttestation": preset_provenance["ownerAttestation"]["status"],
        },
        "licenses": licenses,
        "noticeCompleteness": "complete-for-components-listed-in-artifact-sbom",
        "distributionGate": "BLOCKED",
        "blockers": [
            "compiled-preset-provenance",
            "durable-source-retention",
            "external-counsel-decision",
        ],
    }
    notice_bytes = canonical_bytes(notice_index)
    (legal_root / "notices.json").write_bytes(notice_bytes)
    return {
        "inputCount": len(inputs),
        "componentCount": len(COMPONENT_ORDER),
        "stagedFileCount": len(site_files),
        "artifactSbomSha256": sha256(sbom_bytes),
        "noticeIndexSha256": sha256(notice_bytes),
        "presetProvenanceSha256": sha256(preset_bytes),
        "presetCount": preset_provenance["itemCount"],
        "distributionGate": "BLOCKED",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--emscripten-root", type=Path, required=True)
    parser.add_argument("--site-root", type=Path, required=True)
    parser.add_argument("--map", dest="map_path", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args(argv)
    try:
        result = write_payload(
            source_root=require_real_directory(args.source_root, label="source root"),
            build_root=require_real_directory(args.build_root, label="build root"),
            emscripten_root=require_real_directory(args.emscripten_root, label="Emscripten root"),
            site_root=require_real_directory(args.site_root, label="site root"),
            map_path=args.map_path.resolve(),
            source_sha=args.source_sha,
        )
    except (OSError, UnicodeError, VerificationError, json.JSONDecodeError) as error:
        print(f"self-hosted compliance: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
