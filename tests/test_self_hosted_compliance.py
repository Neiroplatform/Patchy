from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/release/generate-self-hosted-compliance.py"
SPEC = importlib.util.spec_from_file_location("self_hosted_compliance", SCRIPT)
assert SPEC and SPEC.loader
compliance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compliance)

SHA = "a" * 40


class Fixture:
    def __init__(self, root: Path) -> None:
        self.source = root / "source"
        self.build = root / "build"
        self.emscripten = root / "emscripten"
        self.site = self.build / "site"
        for path in (self.source, self.build, self.emscripten, self.site):
            path.mkdir(parents=True, exist_ok=True)
        source_files = {
            "LICENSE": "Patchy license\n",
            "NOTICE-THIRD-PARTY.md": "Patchy notice\n",
            "src/color/lcms2/LICENSE": "lcms\n",
            "src/formats/miniz/LICENSE": "miniz\n",
        }
        emscripten_files = {
            "LICENSE": "emscripten\n",
            "emscripten-version.txt": '"4.0.7"\n',
            "system/lib/libc/musl/COPYRIGHT": "musl\n",
            "system/lib/libcxx/LICENSE.TXT": "libcxx\n",
            "system/lib/libcxxabi/LICENSE.TXT": "libcxxabi\n",
            "system/lib/compiler-rt/LICENSE.TXT": "compiler rt\n",
            "system/lib/libunwind/LICENSE.TXT": "libunwind\n",
            "system/lib/dlmalloc.c": "dlmalloc public domain\n",
        }
        for base, files in ((self.source, source_files), (self.emscripten, emscripten_files)):
            for relative, contents in files.items():
                path = base / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents, encoding="utf-8")
        for relative in (
            "patchy-engine.mjs",
            "patchy-engine.wasm",
            "patchy.html",
            "capabilities.html",
            "legal.html",
        ):
            (self.site / relative).write_bytes(b"wasm" if relative.endswith(".wasm") else f"fixture:{relative}\n".encode())
        self.map = self.build / "patchy-engine.map"
        self.map.write_text(self.map_text(), encoding="utf-8")

    def map_text(self, extra: str = "") -> str:
        entries = [
            "<internal>:(__wasm_call_ctors)",
            "CMakeFiles/patchy_engine_wasm_sdk.dir/src/engine/wasm_sdk_main.cpp.o:(main)",
            "libpatchy_core.a(document.cpp.o):(document)",
            "libpatchy_core.a(pattern_presets.cpp.o):(preset)",
            "libpatchy_lcms2.a(cmsalpha.c.o):(cms)",
            "libpatchy_psd.a(miniz.c.o):(miniz)",
        ]
        emsdk = self.emscripten.as_posix()
        for archive, member in (
            ("libc-mt.a", "printf.o"),
            ("libc++-mt-legacyexcept.a", "string.o"),
            ("libc++abi-mt-legacyexcept.a", "exception.o"),
            ("libcompiler_rt-legacysjlj-mt.a", "muldi3.o"),
            ("libdlmalloc-mt.a", "dlmalloc.o"),
            ("libnoexit.a", "noexit.o"),
            ("libstubs.a", "stubs.o"),
            ("libunwind-mt-legacyexcept.a", "Unwind-wasm.o"),
        ):
            entries.append(f"{emsdk}/cache/sysroot/lib/wasm32-emscripten/{archive}({member}):(symbol)")
        entries.append(f"{emsdk}/cache/sysroot/lib/wasm32-emscripten/crtbegin.o:(crt)")
        if extra:
            entries.append(extra)
        lines = [compliance.MAP_HEADER]
        for index, entry in enumerate(entries, 1):
            lines.append(f"       - {index:8x} {1:8x}         {entry}")
        return "\n".join(lines) + "\n"

    def generate(self) -> dict[str, object]:
        return compliance.write_payload(
            source_root=self.source,
            build_root=self.build,
            emscripten_root=self.emscripten,
            site_root=self.site,
            map_path=self.map,
            source_sha=SHA,
        )


class SelfHostedComplianceTests(unittest.TestCase):
    def test_payload_is_deterministic_closed_and_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            first = fixture.generate()
            first_bytes = {
                path.relative_to(fixture.site / "legal").as_posix(): path.read_bytes()
                for path in (fixture.site / "legal").rglob("*")
                if path.is_file()
            }
            second = fixture.generate()
            second_bytes = {
                path.relative_to(fixture.site / "legal").as_posix(): path.read_bytes()
                for path in (fixture.site / "legal").rglob("*")
                if path.is_file()
            }
            self.assertEqual(first, second)
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first["componentCount"], 11)
            self.assertEqual(first["distributionGate"], "BLOCKED")

            sbom = json.loads(first_bytes["artifact-sbom.cdx.json"])
            self.assertEqual(sbom["bomFormat"], "CycloneDX")
            self.assertEqual(sbom["compositions"], [{"aggregate": "complete", "assemblies": [f"patchy-self-hosted:release@{SHA}"]}])
            self.assertEqual(len(sbom["components"]), 11)
            properties = {item["name"]: item["value"] for item in sbom["metadata"]["component"]["properties"]}
            self.assertEqual(properties["patchy:artifact:closure"], "complete-for-linked-and-staged-inputs")
            self.assertEqual(properties["patchy:artifact:distribution-gate"], "BLOCKED")
            self.assertIn("Qt for WebAssembly", json.loads(properties["patchy:artifact:excluded-components"]))

            notices = json.loads(first_bytes["notices.json"])
            self.assertEqual(len(notices["licenses"]), 11)
            self.assertEqual(notices["distributionGate"], "BLOCKED")
            source = json.loads(first_bytes["source.json"])
            self.assertEqual(source["commit"], SHA)
            self.assertEqual(source["durableRetention"], "not_guaranteed_by_this_artifact")

    def test_forbidden_or_unknown_link_input_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.map.write_text(
                fixture.map_text("libheif.a(decoder.o):(decode)"), encoding="utf-8"
            )
            with self.assertRaisesRegex(compliance.VerificationError, "forbidden/excluded"):
                fixture.generate()

            fixture.map.write_text(
                fixture.map_text(
                    f"{fixture.emscripten.as_posix()}/cache/sysroot/lib/wasm32-emscripten/libmystery.a(mystery.o):(mystery)"
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(compliance.VerificationError, "unknown Emscripten"):
                fixture.generate()


if __name__ == "__main__":
    unittest.main()
