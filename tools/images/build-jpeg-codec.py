"""Build a new portable scaled-JPEG decoder from complete pinned sources in Actions."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import time

if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
    raise RuntimeError("The JPEG codec must be built in GitHub Actions.")

repository = Path(__file__).resolve().parents[2]
recipe = repository / "src/images/jpeg-codec"
offer = json.loads((recipe / "source-offer.json").read_text(encoding="utf-8"))
root = Path(os.environ["RUNNER_TEMP"]) / "mediamanager-jpeg-codec-build"
root.mkdir(exist_ok=False)
artifact = root / "artifact"
runtime = artifact / "runtime"
sources = artifact / "source-offer"
receipts = artifact / "receipts"
objects = root / "objects"
for directory in (runtime, sources, receipts, objects):
    directory.mkdir(parents=True)

receipt = {"schemaVersion": 1, "kind": "jpeg-scaled-wasm", "status": "started",
           "repository": os.environ["GITHUB_REPOSITORY"], "commit": os.environ["GITHUB_SHA"],
           "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
           "workflowRef": os.environ["GITHUB_WORKFLOW_REF"], "runnerOs": os.environ["RUNNER_OS"],
           "runnerArch": os.environ["RUNNER_ARCH"], "imageVersion": os.environ.get("ImageVersion"),
           "sourceOffer": None, "inputs": [], "commands": [], "nativeParityValidated": False,
           "historicalBinaryReplacement": False, "offlineSdkReplaySelfContained": False}


def describe(filename, relative=None):
    with filename.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": relative or filename.name, "bytes": filename.stat().st_size, "sha256": digest}


def write_record(filename, value):
    filename.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def snapshot(directory):
    return [describe(filename, filename.relative_to(directory).as_posix())
            for filename in sorted(directory.rglob("*"))
            if filename.is_file() and not filename.is_symlink()
            and "__pycache__" not in filename.parts and filename.suffix != ".pyc"]


def run(name, arguments, cwd, seconds=120, environment=None):
    command = {"name": name, "arguments": [str(value) for value in arguments],
               "timeoutSeconds": seconds, "started": time.time()}
    receipt["commands"].append(command)
    print("JPEG codec build: " + name, flush=True)
    stdout, stderr = receipts / (name + ".stdout.txt"), receipts / (name + ".stderr.txt")
    with stdout.open("wb") as out, stderr.open("wb") as err:
        process = subprocess.Popen(command["arguments"], cwd=cwd, env=environment,
                                   stdout=out, stderr=err, start_new_session=True)
        try:
            command["exitCode"] = process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            command["timedOut"] = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        finally:
            command["finished"] = time.time()
    command["stdout"], command["stderr"] = describe(stdout), describe(stderr)
    if command["exitCode"] != 0:
        raise RuntimeError(name + " failed; see preserved command evidence")


def checked(filename, expected):
    actual = describe(filename)
    if actual["bytes"] != expected["bytes"] or actual["sha256"] != expected["sha256"]:
        raise RuntimeError("JPEG build input identity changed: " + str(filename))
    return actual


try:
    receipt["sourceOffer"] = describe(recipe / "source-offer.json")
    shutil.copyfile(recipe / "source-offer.json", sources / "source-offer.json")
    shutil.copyfile(Path(__file__), sources / "build-jpeg-codec.py")
    extracted = {}
    for entry in offer["archives"]:
        source = recipe / entry["filename"]
        actual = checked(source, entry)
        receipt["inputs"].append({**actual, "role": entry["id"], "url": entry["url"]})
        shutil.copyfile(source, sources / source.name)
        destination = root / entry["id"]
        destination.mkdir()
        with tarfile.open(source, "r:gz") as packed:
            members = packed.getmembers()
            if len(members) != entry["members"]:
                raise RuntimeError("Source archive membership changed: " + entry["id"])
            packed.extractall(destination, filter="data")
        extracted[entry["id"]] = destination / entry.get("root", "")
    for entry in offer["recipeInputs"]:
        source = repository / entry["filename"]
        receipt["inputs"].append({**checked(source, entry), "role": entry["role"]})
        shutil.copyfile(source, sources / source.name)
    jpeg, cms, emsdk = (extracted[name] for name in ("libjpeg-turbo", "skcms", "emsdk"))
    for entry in offer["skcmsCompiledSources"]:
        checked(cms / entry["filename"], entry)
    source_before = {"libjpeg-turbo": snapshot(jpeg), "skcms": snapshot(cms)}
    write_record(receipts / "sources-before.json", source_before)
    environment = {**os.environ, "EMSDK_KEEP_DOWNLOADS": "1", "PYTHONDONTWRITEBYTECODE": "1",
                   "EM_CACHE": str(root / "em-cache")}
    version = offer["toolchainVersion"]
    run("install-emsdk", ["python3", emsdk / "emsdk.py", "install", version], emsdk, 900, environment)
    run("activate-emsdk", ["python3", emsdk / "emsdk.py", "activate", version], emsdk, 120, environment)
    write_record(receipts / "toolchain-downloads.json", snapshot(emsdk / "downloads"))
    compiler = emsdk / "upstream/emscripten/emcc"
    cxx = emsdk / "upstream/emscripten/em++"
    environment["EM_CONFIG"] = str(emsdk / ".emscripten")
    compiler_source = emsdk / "upstream/emscripten"
    installed_cache = compiler_source / "cache"
    if installed_cache.is_dir():
        shutil.copytree(installed_cache, root / "em-cache", dirs_exist_ok=False, symlinks=True)
    write_record(receipts / "compiler-cache-inputs.json", snapshot(root / "em-cache"))
    run("compiler-version", [compiler, "--version"], root, environment=environment)
    version_output = (receipts / "compiler-version.stdout.txt").read_text(encoding="utf-8")
    if " " + version + " " not in version_output:
        raise RuntimeError("The activated compiler version differs from its fixed release")
    compiler_before = snapshot(compiler_source)
    write_record(receipts / "compiler-sources-before.json", compiler_before)
    # Retain complete compiler/runtime source, excluding only generated cache and Python bytecode.
    with tarfile.open(sources / "emscripten-runtime-source.tar.gz", "w:gz") as packed:
        for filename in sorted(compiler_source.rglob("*")):
            relative = filename.relative_to(compiler_source)
            if "cache" in relative.parts or "__pycache__" in relative.parts or filename.suffix == ".pyc":
                continue
            packed.add(filename, arcname=relative.as_posix(), recursive=False)
    common = ["-O3", "-ffp-contract=off", "-fno-strict-aliasing", "-DNO_GETENV", "-DNO_PUTENV",
              "-I" + str(jpeg), "-I" + str(cms)]
    for filename in offer["jpegCompiledSources"]:
        target = objects / (Path(filename).stem + ".o")
        run("compile-" + target.stem, [compiler, "-std=c11", *common, "-c", jpeg / filename, "-o", target], root, environment=environment)
    run("compile-skcms", [cxx, "-std=c++17", *common, "-DSKCMS_PORTABLE", "-DSKCMS_NO_RUNTIME_CPU_DETECTION",
                          "-fno-exceptions", "-fno-rtti", "-c", cms / "skcms.cc", "-o", objects / "skcms.o"], root, environment=environment)
    run("compile-bridge", [compiler, "-std=c11", *common, "-c", recipe / "bridge.c", "-o", objects / "bridge.o"], root, environment=environment)
    exports = ["_malloc", "_free", "_mm_jpeg_decode", "_mm_jpeg_succeeded", "_mm_jpeg_width", "_mm_jpeg_height",
               "_mm_jpeg_pixels", "_mm_jpeg_error", "_mm_jpeg_free"]
    link = [cxx, "-O3", "--no-entry", *sorted(objects.glob("*.o")), "-o", runtime / "jpeg-codec.mjs",
            "-sENVIRONMENT=node", "-sFILESYSTEM=0", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createJpegCodec",
            "-sALLOW_MEMORY_GROWTH=1", "-sABORTING_MALLOC=0", "-sMAXIMUM_MEMORY=2147483648",
            "-sEXPORTED_FUNCTIONS=" + json.dumps(exports),
            "-sEXPORTED_RUNTIME_METHODS=" + json.dumps(["HEAPU8", "UTF8ToString"])]
    run("link-codec", link, root, 300, environment)
    write_record(receipts / "compiler-cache-after.json", snapshot(root / "em-cache"))
    source_after = {"libjpeg-turbo": snapshot(jpeg), "skcms": snapshot(cms)}
    write_record(receipts / "sources-after.json", source_after)
    compiler_after = snapshot(compiler_source)
    write_record(receipts / "compiler-sources-after.json", compiler_after)
    if source_before != source_after or compiler_before != compiler_after:
        raise RuntimeError("Source files changed during JPEG compilation")
    receipt["sourceUnchangedDuringBuild"] = True
    for source, name in [(jpeg / "LICENSE.md", "LICENSE.libjpeg-turbo.md"), (jpeg / "README.ijg", "README.ijg"),
                         (cms / "LICENSE", "LICENSE.skcms"), (compiler_source / "LICENSE", "LICENSE.emscripten")]:
        shutil.copyfile(source, runtime / name)
    shutil.copyfile(recipe / "NOTICE.txt", runtime / "NOTICE.txt")
    run("load-generated-module", ["node", repository / "tools/images/smoke-jpeg-codec.mjs", runtime], root, environment=environment)
    receipt["runtime"] = snapshot(runtime)
    receipt["runtimeSourceArchive"] = describe(sources / "emscripten-runtime-source.tar.gz")
    receipt["sourceOfferFiles"] = snapshot(sources)
    receipt["status"] = "built"
except BaseException as error:
    receipt["status"] = "failed"
    receipt["error"] = str(error)
    raise
finally:
    write_record(receipts / "build-receipt.json", receipt)
