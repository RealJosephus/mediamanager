"""Produce new neutral JPEG boundary assets in Actions; never record expected pixels."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
    raise RuntimeError("JPEG inputs must be generated in GitHub Actions.")
repository = Path(__file__).resolve().parents[2]
recipe = repository / "src/images/jpeg-codec"
offer = json.loads((recipe / "source-offer.json").read_text(encoding="utf-8"))
root = Path(os.environ["RUNNER_TEMP"]) / "mediamanager-jpeg-inputs"
root.mkdir(exist_ok=False)
artifact = root / "artifact"
assets = artifact / "assets"
receipts = artifact / "receipts"
for directory in (assets, receipts):
    directory.mkdir(parents=True)
record = {"schemaVersion": 1, "scope": "New independently declared JPEG input generation, not native observations or decoder validation.",
          "repository": os.environ["GITHUB_REPOSITORY"], "commit": os.environ["GITHUB_SHA"],
          "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
          "status": "started", "commands": [], "sourceInputs": [], "assets": [], "nativeResultsRecorded": False}


def describe(filename, relative=None):
    with filename.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"filename": relative or filename.name, "bytes": filename.stat().st_size, "sha256": digest}


def run(name, arguments):
    command = {"name": name, "arguments": [str(value) for value in arguments], "started": time.time()}
    record["commands"].append(command)
    with (receipts / (name + ".stdout.txt")).open("wb") as stdout, (receipts / (name + ".stderr.txt")).open("wb") as stderr:
        result = subprocess.run(command["arguments"], cwd=root, stdout=stdout, stderr=stderr, timeout=180, check=False)
    command["exitCode"], command["finished"] = result.returncode, time.time()
    if result.returncode != 0:
        raise RuntimeError(name + " failed; see input-generation evidence")


def header(bytes_):
    if bytes_[:2] != b"\xff\xd8":
        return {"jpegSignature": False}
    value = {"jpegSignature": True}
    offset = 2
    while offset + 4 <= len(bytes_):
        if bytes_[offset] != 255:
            break
        while bytes_[offset] == 255:
            offset += 1
        marker = bytes_[offset]
        offset += 1
        if marker in (0xda, 0xd9):
            break
        length = int.from_bytes(bytes_[offset:offset + 2], "big")
        if length < 2 or offset + length > len(bytes_):
            break
        data = bytes_[offset + 2:offset + length]
        if marker in (0xc0, 0xc1, 0xc2):
            value.update({"frameMarker": marker, "height": int.from_bytes(data[1:3], "big"),
                          "width": int.from_bytes(data[3:5], "big"), "components": data[5]})
        if marker == 0xee and data[:5] == b"Adobe" and len(data) >= 12:
            value["adobeTransform"] = data[11]
        offset += length
    return value


try:
    libraries = {}
    for name in ("libjpeg-turbo", "skcms"):
        entry = next(row for row in offer["archives"] if row["id"] == name)
        source = recipe / entry["filename"]
        actual = describe(source)
        if actual["bytes"] != entry["bytes"] or actual["sha256"] != entry["sha256"]:
            raise RuntimeError("Input encoder source changed: " + name)
        record["sourceInputs"].append({**actual, "role": name, "url": entry["url"]})
        library = root / name
        library.mkdir()
        with tarfile.open(source, "r:gz") as packed:
            packed.extractall(library, filter="data")
        libraries[name] = library
    jpeg, cms = (libraries[name] for name in ("libjpeg-turbo", "skcms"))
    restored = {"upstream-gray.jpg": jpeg / "testimages/testout_gray_islow.jpg",
                "upstream-progressive.jpg": jpeg / "testimages/testout_420_islow_prog.jpg",
                "upstream-rgb.jpg": jpeg / "testimages/testout_rgb_islow.jpg",
                "rgb.icc": cms / "profiles/misc/AdobeRGB.icc",
                "cmyk.icc": cms / "profiles/misc/Coated_FOGRA39_CMYK.icc"}
    for name, source in restored.items():
        shutil.copyfile(source, assets / name)
        record["assets"].append({**describe(assets / name), "origin": "exact-upstream-member",
                                 "member": source.relative_to(libraries["libjpeg-turbo"] if source.is_relative_to(jpeg) else cms).as_posix()})
    for source, name in [(jpeg / "README.ijg", "README.ijg"), (jpeg / "LICENSE.md", "LICENSE.libjpeg-turbo.md"), (cms / "LICENSE", "LICENSE.skcms")]:
        shutil.copyfile(source, artifact / name)
    producer = repository / "tools/images/generate-jpeg-boundaries.c"
    record["sourceInputs"].append({**describe(producer), "role": "neutral-pixel-pattern-producer"})
    shutil.copyfile(producer, artifact / producer.name)
    shutil.copyfile(Path(__file__), artifact / Path(__file__).name)
    compiler = Path(shutil.which("cc")).resolve()
    record["compiler"] = describe(compiler)
    run("compiler-version", [compiler, "--version"])
    executable = root / "generate-jpeg-boundaries"
    run("compile-neutral-producer", [compiler, "-O2", "-std=c11", "-DNO_GETENV", "-DNO_PUTENV", "-I" + str(jpeg),
                                     *[jpeg / name for name in offer["jpegCompiledSources"]], producer, "-lm", "-o", executable])
    record["producerBinary"] = describe(executable)
    invalid_profile = assets / "invalid.icc"
    invalid_profile.write_bytes(b"Explicit malformed ICC profile input, not expected decoder output.\n")
    generated = [("generated-rgb.jpg", "rgb", None), ("generated-cmyk.jpg", "cmyk", None), ("generated-ycck.jpg", "ycck", None),
                 ("rgb-profile.jpg", "rgb", "rgb.icc"), ("cmyk-profile.jpg", "cmyk", "cmyk.icc"),
                 ("mismatched-profile.jpg", "rgb", "cmyk.icc"), ("malformed-profile.jpg", "rgb", "invalid.icc")]
    for name, color, profile in generated:
        arguments = [executable, assets / name, color, "sequential"]
        if profile:
            arguments.append(assets / profile)
        run("generate-" + name, arguments)
        shape = header((assets / name).read_bytes())
        if shape.get("components") != (3 if color == "rgb" else 4):
            raise RuntimeError("Generated JPEG component declaration is incorrect")
        if color == "ycck" and shape.get("adobeTransform") != 2:
            raise RuntimeError("The YCCK source must actually contain Adobe transform 2")
        record["assets"].append({**describe(assets / name), "origin": "declared-neutral-pattern", "color": color, "header": shape, "profile": profile})
    original = (assets / "generated-rgb.jpg").read_bytes()
    mutations = {"truncated-eoi.jpg": original[:-2], "truncated-scan.jpg": original[:len(original) // 2],
                 "bad-marker.jpg": b"\xff\x00" + original[2:]}
    for name, bytes_ in mutations.items():
        (assets / name).write_bytes(bytes_)
        record["assets"].append({**describe(assets / name), "origin": "explicit-source-mutation", "source": "generated-rgb.jpg", "mutation": name})
    record["assets"].append({**describe(invalid_profile), "origin": "literal-malformed-profile"})
    record["status"] = "generated"
except BaseException as error:
    record["status"] = "failed"
    record["error"] = str(error)
    raise
finally:
    (artifact / "generation-receipt.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
