"""Recover already pinned source bytes; this does not compile or run a codec."""

import hashlib
import json
import os
import pathlib
import re
import sys
import tarfile


ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
CACHE = pathlib.Path(sys.argv[1]).resolve()
EMSCRIPTEN_COMMIT = "ce6d2aad8bbf1e508e5a6d112f986617198bdc0d"
SHARP_COMMIT = "c083c6efd843a844b0c8f7878787360e815be781"
HISTORICAL_ROOT = "D:/mediamanager-validation/20261016-book-stage/"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(filename):
    return json.loads(filename.read_bytes())


def descriptor(filename, role=None):
    data = filename.read_bytes()
    result = {"filename": filename.relative_to(HERE).as_posix() if filename.is_relative_to(HERE)
              else pathlib.Path(os.path.relpath(filename, HERE)).as_posix(),
              "bytes": len(data), "sha256": digest(data)}
    if role:
        result["role"] = role
    return result


def preserve(filename, data):
    filename.parent.mkdir(parents=True, exist_ok=True)
    if filename.exists():
        if filename.read_bytes() != data:
            raise OSError("Refusing to replace recovered input: " + str(filename))
    else:
        filename.write_bytes(data)


def apply_patch(original, patch):
    old = original.splitlines(keepends=True)
    lines = patch.decode("utf-8").splitlines(keepends=True)
    result, position, index = [], 0, 0
    while index < len(lines):
        match = re.match(r"@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@", lines[index])
        if not match:
            index += 1
            continue
        start = int(match.group(1)) - 1
        result.extend(old[position:start])
        position = start
        index += 1
        while index < len(lines) and not lines[index].startswith(("@@ ", "diff --git ")):
            line = lines[index]
            if line.startswith("\\ No newline"):
                raise OSError("Unexpected unterminated patch line")
            if line[:1] in (" ", "-"):
                expected = line[1:].replace("\r\n", "\n").encode("utf-8")
                if position >= len(old) or old[position] != expected:
                    raise OSError("The patch does not match the exact original source")
                if line.startswith(" "):
                    result.append(old[position])
                position += 1
            elif line.startswith("+"):
                result.append(line[1:].replace("\r\n", "\n").encode("utf-8"))
            else:
                break
            index += 1
    result.extend(old[position:])
    return b"".join(result)


licenses_file = ROOT / "src/storage/resources/archive-codec-licenses-provenance.json"
rar4_file = ROOT / "src/storage/resources/archive-codec-rar4.provenance.json"
rar5_file = ROOT / "src/storage/resources/archive-codec-rar5-provenance.json"
builder_file = ROOT / "tools/archive-codec-sources.json"
wrapper_file = ROOT / "tests/storage/fixtures/archive-codec/provenance.json"
licenses, rar4, builder = map(read_json, [licenses_file, rar4_file, builder_file])
archives, opened, sources, missing = [], {}, [], []

for package in builder["sourceArchives"]:
    source = CACHE / package["archiveName"]
    data = source.read_bytes()
    if len(data) != package["bytes"] or digest(data) != package["sha256"]:
        raise OSError("The official source archive differs: " + package["archiveName"])
    target = HERE / "source-archives" / package["archiveName"]
    preserve(target, data)
    archives.append({"id": package["name"], **descriptor(target), "url": package["url"],
                     "upstreamDirectory": package["directory"], "identity": "original-pinned-release"})
    opened[package["name"]] = tarfile.open(target, "r:gz")

emscripten_name = "emscripten-" + EMSCRIPTEN_COMMIT + ".tar.gz"
emscripten_target = HERE / "source-archives" / emscripten_name
preserve(emscripten_target, (CACHE / emscripten_name).read_bytes())
archives.append({"id": "emscripten", **descriptor(emscripten_target), "commit": EMSCRIPTEN_COMMIT,
                 "url": "https://codeload.github.com/emscripten-core/emscripten/tar.gz/" + EMSCRIPTEN_COMMIT,
                 "upstreamDirectory": "emscripten-" + EMSCRIPTEN_COMMIT,
                 "identity": "new-source-acquisition-with-exact-original-member-pins",
                 "originalToolchainCommitKnown": False})
opened["emscripten"] = tarfile.open(emscripten_target, "r:gz")

sharp_paths = {entry["path"]: entry["relative"] for entry in licenses["sharpCompressSourceReferences"]}
for name, relative in {
    "ArchiveEncoding.cs": "src/SharpCompress/Common/ArchiveEncoding.cs",
    "ArchiveEncodingExtensions.cs": "src/SharpCompress/Common/ArchiveEncodingExtensions.cs",
    "FileHeader.Async.cs": "src/SharpCompress/Common/Rar/Headers/FileHeader.Async.cs",
    "FileHeader.cs": "src/SharpCompress/Common/Rar/Headers/FileHeader.cs",
    "FileNameDecoder.cs": "src/SharpCompress/Common/Rar/Headers/FileNameDecoder.cs",
    "RarEntry.cs": "src/SharpCompress/Common/Rar/RarEntry.cs",
}.items():
    sharp_paths[HISTORICAL_ROOT + "inputs/comic-rar-paths-2/" + name] = relative

requirements = {}
for entry in licenses["sourceFiles"]:
    filename = entry["filename"]
    if (filename.startswith(HISTORICAL_ROOT + "archive-build-1/")
            and any("/" + package["directory"] + "/" in filename for package in builder["sourceArchives"])) \
            or (filename.startswith(HISTORICAL_ROOT + "archive-toolchain-2/emscripten/")
                and not filename.endswith(".a")) \
            or filename in sharp_paths \
            or filename == HISTORICAL_ROOT + "inputs/comic-upstream-1/LICENSE.txt" \
            or filename == HISTORICAL_ROOT + "results/archive-licenses-2/CC0-1.0.txt" \
            or filename in [item["filename"] for item in licenses["finalCodecBuild"]["modifiedLibarchiveSources"]]:
        requirements[filename] = entry
for entry in rar4["requiredInputs"]:
    filename = entry.get("filename", entry.get("path"))
    if filename in sharp_paths:
        requirements[filename] = {"filename": filename, "bytes": entry["bytes"], "sha256": entry["sha256"],
                                  "role": "Referenced SharpCompress filename/selected-entry source"}

for filename, entry in sorted(requirements.items()):
    record = {"originalFilename": filename, "bytes": entry["bytes"], "sha256": entry["sha256"], "role": entry["role"]}
    data = None
    for archive in archives:
        if archive["id"] == "emscripten":
            prefix = HISTORICAL_ROOT + "archive-toolchain-2/emscripten/"
            member = archive["upstreamDirectory"] + "/" + filename.removeprefix(prefix)
        else:
            prefix = HISTORICAL_ROOT + "archive-build-1/" + archive["upstreamDirectory"] + "/"
            member = archive["upstreamDirectory"] + "/" + filename.removeprefix(prefix)
        if filename.startswith(prefix):
            if member == "zlib-1.3.1/zconf.h.included":
                member = "zlib-1.3.1/zconf.h"
                record["sourceNameAtCapture"] = "zconf.h.included"
            try:
                info = opened[archive["id"]].getmember(member)
            except KeyError:
                record.update({"kind": "archive-member", "archive": archive["id"], "member": member})
                break
            if not info.isfile():
                raise OSError("An original source is not a regular archive member: " + member)
            data = opened[archive["id"]].extractfile(info).read()
            record.update({"kind": "archive-member", "archive": archive["id"], "member": member})
            break
    if data is None and filename in sharp_paths:
        member = sharp_paths[filename]
        data = (CACHE / ("SharpCompress-" + member.rsplit("/", 1)[-1])).read_bytes()
        target = HERE / "sources/sharpcompress" / member
        preserve(target, data)
        record.update({"kind": "file", "filename": target.relative_to(HERE).as_posix(), "commit": SHARP_COMMIT,
                       "upstreamPath": member,
                       "url": "https://raw.githubusercontent.com/adamhathcock/sharpcompress/" + SHARP_COMMIT + "/" + member})
    if data is None and filename.endswith("/inputs/comic-upstream-1/LICENSE.txt"):
        data = (CACHE / "SharpCompress.LICENSE.txt").read_bytes()
        target = HERE / "sources/sharpcompress/LICENSE.txt"
        preserve(target, data)
        record.update({"kind": "file", "filename": target.relative_to(HERE).as_posix(), "commit": SHARP_COMMIT,
                       "upstreamPath": "LICENSE.txt",
                       "url": "https://raw.githubusercontent.com/adamhathcock/sharpcompress/" + SHARP_COMMIT + "/LICENSE.txt"})
    if data is None and filename.endswith("/CC0-1.0.txt"):
        data = (CACHE / "CC0-1.0.txt").read_bytes()
        target = HERE / "sources/CC0-1.0.txt"
        preserve(target, data)
        record.update({"kind": "file", "filename": target.relative_to(HERE).as_posix(), "url": licenses["download"]["url"]})
    if data is None and filename in [item["filename"] for item in licenses["finalCodecBuild"]["modifiedLibarchiveSources"]]:
        name = filename.rsplit("/", 1)[-1]
        original = opened["libarchive"].extractfile("libarchive-3.8.10/libarchive/" + name).read()
        patch_name = "archive-codec-rar4.patch" if name.endswith("rar.c") else "archive-codec-rar5.patch"
        patch = ROOT / "src/storage/resources" / patch_name
        data = apply_patch(original, patch.read_bytes())
        target = HERE / "sources/patched-libarchive" / name
        preserve(target, data)
        record.update({"kind": "file", "filename": target.relative_to(HERE).as_posix(),
                       "derivedFrom": {"archive": "libarchive", "member": "libarchive-3.8.10/libarchive/" + name,
                                       "sha256": digest(original), "patch": descriptor(patch)}})
    if data is None or len(data) != entry["bytes"] or digest(data) != entry["sha256"]:
        record["recovered"] = False
        record["actualSha256"] = digest(data) if data is not None else None
        missing.append(record)
    else:
        record["recovered"] = True
    sources.append(record)

for archive in opened.values():
    archive.close()
manifest = {"schemaVersion": 1,
            "scope": "Exact source recovery and unchanged published codec/license package identity; no compilation, historical build replay, or release acceptance.",
            "sourceRecoveryComplete": not missing,
            "newCodecBuildExecuted": False, "historicalLinkMapReplayed": False,
            "archives": archives, "sources": sources, "unresolvedSources": missing,
            "historicalManifests": [{"name": name, **descriptor(filename, "unchanged-historical-record")}
                                    for name, filename in [("licenses", licenses_file), ("rar4", rar4_file), ("rar5", rar5_file),
                                                           ("builder", builder_file), ("wrapper", wrapper_file)]],
            "sectionCount": len(licenses["sections"]),
            "sectionOriginals": sorted({origin["filename"] for section in licenses["sections"] for origin in section["origins"]}),
            "runtimeSourceOriginals": sorted({entry["source"]["filename"] for entry in licenses["finalCodecBuild"]["runtimeObjects"]}),
            "functionalConsumers": ["tests/metadata/book-comic-provider.test.js", "tests/metadata/book-comic-cover.test.js",
                                    "tests/storage/book-archives.test.js", "tests/storage/rar-entry.test.js"]}
(HERE / "source-offer.json").write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
print(json.dumps({"sourceRecoveryComplete": not missing, "sources": len(sources), "missing": missing,
                  "archiveBytes": sum(entry["bytes"] for entry in archives), "sectionCount": len(licenses["sections"])}))
