"""Generate declared JPEG dimensions in Actions without recording decoder expectations."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
    raise RuntimeError("JPEG scale inputs must be generated in GitHub Actions.")

repository = Path(__file__).resolve().parents[2]
recipe = repository / "src/images/jpeg-codec"
root = Path(os.environ["RUNNER_TEMP"]) / "mediamanager-jpeg-scale-inputs"
root.mkdir(exist_ok=False)
artifact = root / "artifact"
assets, receipts = artifact / "assets", artifact / "receipts"
for directory in (assets, receipts, artifact / "recipe", artifact / "sources", artifact / "producer", artifact / "compiler", artifact / "licenses"):
    directory.mkdir(parents=True)

record = {"schemaVersion": 1, "identity": "independent-jpeg-scale-boundary-inputs",
          "scope": "Fourteen neutral JPEG inputs straddling source-dimension scale boundaries; no expected decoder pixels, BlurHash values or Native observations.",
          "repository": os.environ["GITHUB_REPOSITORY"], "commit": os.environ["GITHUB_SHA"],
          "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
          "ref": os.environ["GITHUB_REF"], "runner": {key: os.environ.get(key) for key in ("RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion")},
          "status": "started", "commands": [], "sourceInputs": [], "licenses": [], "assets": [],
          "nativeResultsRecorded": False, "expectedPixelsRecorded": False, "decoderResultsRecorded": False,
          "compilerClosureArchived": False, "phaseAcceptance": False, "releaseAcceptance": False}
pins = []


def describe(filename, relative=None):
    filename = Path(filename)
    with filename.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"filename": relative or filename.name, "bytes": filename.stat().st_size, "sha256": digest}


def save_json(filename, value):
    filename.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n")


def copy_input(source, relative, role, **extra):
    destination = artifact / relative
    shutil.copyfile(source, destination)
    actual = describe(source, relative)
    if describe(destination, relative) != actual:
        raise RuntimeError("Copied input differs: " + relative)
    pins.append((source, actual))
    record["sourceInputs"].append({**actual, "originalFilename": str(source), "role": role, **extra})
    return actual


def run(name, arguments, cwd=root, timeout=240):
    command = {"name": name, "arguments": [str(value) for value in arguments], "cwd": str(cwd),
               "timeoutSeconds": timeout, "started": time.time()}
    record["commands"].append(command)
    stdout, stderr = receipts / (name + ".stdout.txt"), receipts / (name + ".stderr.txt")
    try:
        with stdout.open("wb") as out, stderr.open("wb") as err:
            result = subprocess.run(command["arguments"], cwd=cwd, stdout=out, stderr=err, timeout=timeout, check=False)
        command["exitCode"] = result.returncode
    except BaseException as error:
        command["error"] = str(error)
        raise
    finally:
        command["finished"] = time.time()
        for key, filename in (("stdout", stdout), ("stderr", stderr)):
            if filename.exists():
                command[key] = describe(filename, filename.relative_to(artifact).as_posix())
    if result.returncode != 0:
        raise RuntimeError(name + " failed; see generation receipts")
    return stdout.read_bytes()


def source_manifest(directory):
    return [describe(filename, filename.relative_to(directory).as_posix())
            for filename in sorted(directory.rglob("*")) if filename.is_file()]


def jpeg_header(data):
    if data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise RuntimeError("Generated JPEG is incomplete")
    offset, frames, jfif = 2, [], False
    while offset + 4 <= len(data):
        if data[offset] != 255:
            raise RuntimeError("Invalid generated JPEG marker")
        while offset < len(data) and data[offset] == 255:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker == 0xda:
            break
        length = int.from_bytes(data[offset:offset + 2], "big")
        if length < 2 or offset + length > len(data):
            raise RuntimeError("Invalid generated JPEG segment")
        body = data[offset + 2:offset + length]
        if marker == 0xe0 and body[:5] == b"JFIF\0":
            jfif = True
        if marker in (0xc0, 0xc1, 0xc2):
            if len(body) < 6 or len(body) != 6 + body[5] * 3:
                raise RuntimeError("Invalid generated JPEG frame")
            frames.append({"frameMarker": marker, "precision": body[0],
                           "height": int.from_bytes(body[1:3], "big"), "width": int.from_bytes(body[3:5], "big"),
                           "components": body[5], "componentInfo": [
                               {"id": body[6 + index * 3], "horizontalSampling": body[7 + index * 3] >> 4,
                                "verticalSampling": body[7 + index * 3] & 15, "quantizationTable": body[8 + index * 3]}
                               for index in range(body[5])]})
        offset += length
    if len(frames) != 1:
        raise RuntimeError("Generated JPEG must contain one frame")
    return {**frames[0], "jfif": jfif}


try:
    head = run("checkout-head", ["git", "rev-parse", "HEAD"], cwd=repository).decode().strip()
    if head != record["commit"] or run("checkout-status-before", ["git", "status", "--porcelain"], cwd=repository).strip():
        raise RuntimeError("The input producer checkout must be exact and clean")
    record["checkoutHead"] = head
    record["interpreter"] = {**describe(Path(sys.executable).resolve()), "version": sys.version}
    offer_file = recipe / "source-offer.json"
    offer = json.loads(offer_file.read_text(encoding="utf-8"))
    source = next(entry for entry in offer["archives"] if entry["id"] == "libjpeg-turbo")
    expected = {"filename": "source-archives/libjpeg-turbo-927aabfcd26897abb9776ecf2a6c38ea5bb52ab6.tar.gz",
                "commit": "927aabfcd26897abb9776ecf2a6c38ea5bb52ab6", "bytes": 2329095,
                "sha256": "a6f1f337693fcb5b64e6e5a0e005e53f361a4363567dbcb71e4e09ffdf60c0e1"}
    if any(source[key] != value for key, value in expected.items()):
        raise RuntimeError("The original libjpeg-turbo source identity changed")
    archive = recipe / source["filename"]
    actual = describe(archive)
    if any(actual[key] != expected[key] for key in ("bytes", "sha256")):
        raise RuntimeError("The pinned libjpeg-turbo archive bytes changed")
    copy_input(archive, "sources/" + archive.name, "complete-original-libjpeg-turbo-archive", url=source["url"], commit=source["commit"])
    producer = Path(__file__).with_suffix(".c")
    for source_file, role in ((offer_file, "original-codec-source-offer"), (producer, "neutral-rgb-pattern-producer"),
                              (Path(__file__), "generation-recipe"),
                              (repository / "tools/images/generate-jpeg-boundaries.c", "original-rgb-pattern-producer"),
                              (repository / ".github/workflows/generate-jpeg-scale-boundaries.yml", "generation-workflow")):
        copy_input(source_file, "recipe/" + source_file.name, role)
    jpeg = root / "libjpeg-turbo"
    jpeg.mkdir()
    with tarfile.open(archive, "r:gz") as packed:
        packed.extractall(jpeg, filter="data")
    before = source_manifest(jpeg)
    save_json(receipts / "libjpeg-source-before.json", before)
    for member in ("LICENSE.md", "README.ijg"):
        relative = "licenses/" + member
        copied = copy_input(jpeg / member, relative, "original-libjpeg-turbo-license", archiveMember=member)
        record["licenses"].append({**copied, "archiveMember": member})
    declaration = {"identity": record["identity"], "maxDimension": 128,
                   "pattern": "(x*(17+channel*11)+y*(29+channel*7)+channel*53)&255",
                   "encoder": {"inputColor": "RGB", "jpegColor": "YCbCr", "quality": 87,
                               "dct": "JDCT_ISLOW", "sampling": "1x1", "progressive": False}, "images": []}
    for n in range(2, 9):
        denominator = 2 * n - 1
        for rounding, width in (("floor", 2048 // denominator), ("ceil", (2048 + denominator - 1) // denominator)):
            height = max(1, width * 193 // 257)
            declaration["images"].append({"name": "scale-n" + str(n) + "-width-" + rounding,
                "filename": "scale-n" + str(n) + "-width-" + rounding + ".jpg", "n": n,
                "widthRounding": rounding, "widthBoundary": {"numerator": 2048, "denominator": denominator},
                "scaleBoundary": {"numerator": denominator, "denominator": 16},
                "sourceScaleRatio": {"numerator": 128, "denominator": width}, "width": width, "height": height})
    save_json(artifact / "input-declaration.json", declaration)
    compiler = Path(shutil.which("cc")).resolve()
    record["compiler"] = {**copy_input(compiler, "compiler/driver", "actual-runner-c-compiler-driver"), "originalFilename": str(compiler)}
    run("compiler-version", [compiler, "--version"])
    compiled = [jpeg / name for name in offer["jpegCompiledSources"]]
    record["compiledSources"] = [describe(filename, filename.relative_to(jpeg).as_posix()) for filename in compiled]
    executable = artifact / "producer/generate-jpeg-scale-boundaries"
    run("compile-neutral-producer", [compiler, "-O2", "-std=c11", "-DNO_GETENV", "-DNO_PUTENV", "-I" + str(jpeg),
                                     *compiled, producer, "-lm", "-o", executable])
    record["producerBinary"] = describe(executable, executable.relative_to(artifact).as_posix())
    for image in declaration["images"]:
        filename = assets / image["filename"]
        run("generate-" + image["name"], [executable, filename, image["width"], image["height"]])
        header = jpeg_header(filename.read_bytes())
        if (header["width"], header["height"], header["components"], header["precision"], header["frameMarker"], header["jfif"]) != (
                image["width"], image["height"], 3, 8, 0xc0, True):
            raise RuntimeError("Generated JPEG frame differs from the declared input")
        if any(component["horizontalSampling"] != 1 or component["verticalSampling"] != 1 for component in header["componentInfo"]):
            raise RuntimeError("Generated JPEG must retain 1x1 sampling")
        record["assets"].append({**image, **describe(filename, "assets/" + image["filename"]),
                                 "origin": "declared-neutral-rgb-pattern", "header": header})
    after = source_manifest(jpeg)
    save_json(receipts / "libjpeg-source-after.json", after)
    record["sourceUnchangedDuringGeneration"] = before == after
    if not record["sourceUnchangedDuringGeneration"]:
        raise RuntimeError("The extracted encoder source changed")
    for source_file, pin in pins:
        if describe(source_file, pin["filename"]) != pin:
            raise RuntimeError("A generation input changed: " + str(source_file))
    record["generationInputsUnchanged"] = True
    if run("checkout-status-after", ["git", "status", "--porcelain"], cwd=repository).strip():
        raise RuntimeError("Input generation changed the checkout")
    record["status"] = "generated"
except BaseException as error:
    record["status"], record["error"] = "failed", str(error)
    raise
finally:
    record["artifactFiles"] = source_manifest(artifact)
    save_json(artifact / "generation-receipt.json", record)
