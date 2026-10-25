"""Build the upstream hbjs ABI with kerning/AAT enabled, only in Actions."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request

if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
    raise RuntimeError("HarfBuzz must be built in GitHub Actions.")

root = Path(os.environ["RUNNER_TEMP"]) / "mediamanager-harfbuzz-build"
root.mkdir(exist_ok=False)
artifact = root / "artifact"
runtime = artifact / "runtime"
sources = artifact / "source-offer"
receipts = artifact / "receipts"
for directory in (runtime, sources, receipts):
    directory.mkdir(parents=True)

pins = [
    ("hbjs", "https://codeload.github.com/harfbuzz/harfbuzzjs/tar.gz/79860e8f1343093469dace1546aad148e08b47de",
     1275421, "017e3289b3a98ac7a07c22e8561b8249ba520d97e7f27ca74bcf43d8347988c4"),
    ("harfbuzz", "https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/c7a7457b7385f33178e8cf87615ca077a810bbe7",
     38888629, "10dcea60bd85ff219490d55525630650ac8c57044c4efdc878162f286451775b"),
    ("emsdk", "https://codeload.github.com/emscripten-core/emsdk/tar.gz/404dc1ec13f64fce1af1eaf5c007e18212f63527",
     200908, "bf4e2482096e80fdb2f2883ca87fb129d3ade763cc13b7802531479c1628b46f"),
    ("npm", "https://registry.npmjs.org/harfbuzzjs/-/harfbuzzjs-1.6.3.tgz",
     492574, "d911e1d8ffe0ba977f6a693d3b9a83941384c8df84087ff5d5e5ec8d1f085b8c"),
]
receipt = {"schemaVersion": 1, "kind": "harfbuzz-complete-wasm", "status": "started",
           "repository": os.environ["GITHUB_REPOSITORY"], "commit": os.environ["GITHUB_SHA"],
           "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
           "emscriptenVersion": "4.0.13", "imageVersion": os.environ.get("ImageVersion"),
           "sources": [], "commands": [], "productFontParityValidated": False}


def describe(filename, relative=None):
    with filename.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": relative or filename.name, "bytes": filename.stat().st_size, "sha256": digest}


def write_record(filename, value):
    filename.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run(name, args, cwd, seconds=60, env=None):
    record = {"name": name, "arguments": args, "timeoutSeconds": seconds, "started": time.time()}
    receipt["commands"].append(record)
    print("HarfBuzz build: " + name, flush=True)
    stdout = receipts / (name + ".stdout.txt")
    stderr = receipts / (name + ".stderr.txt")
    with stdout.open("wb") as out, stderr.open("wb") as err:
        process = subprocess.Popen(args, cwd=cwd, stdout=out, stderr=err, env=env, start_new_session=True)
        try:
            record["exitCode"] = process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            record["timedOut"] = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        finally:
            record["finished"] = time.time()
    record["stdout"] = describe(stdout)
    record["stderr"] = describe(stderr)
    if record["exitCode"] != 0:
        raise RuntimeError(name + " failed; see command evidence")


def snapshot(directory):
    return [describe(p, p.relative_to(directory).as_posix())
            for p in sorted(directory.rglob("*")) if p.is_file() and not p.is_symlink()]


try:
    extracted = {}
    for name, url, size, digest in pins:
        archive = sources / (name + ".tar.gz")
        with urllib.request.urlopen(url, timeout=90) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        identity = describe(archive)
        if identity["bytes"] != size or identity["sha256"] != digest:
            raise RuntimeError("Upstream archive changed: " + name)
        receipt["sources"].append({**identity, "url": url})
        destination = root / name
        destination.mkdir()
        with tarfile.open(archive, "r:gz") as packed:
            packed.extractall(destination, filter="data")
        children = list(destination.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise RuntimeError("Unexpected archive root: " + name)
        extracted[name] = children[0]

    hbjs, hb, emsdk, npm = (extracted[key] for key in ("hbjs", "harfbuzz", "emsdk", "npm"))
    shutil.copytree(hb, hbjs / "harfbuzz", dirs_exist_ok=True)
    makefile = hbjs / "Makefile"
    before = makefile.read_text(encoding="utf-8")
    disabled = "\t-DHB_TINY \\\n"
    if before.count(disabled) != 1:
        raise RuntimeError("Upstream tiny build flag changed")
    makefile.write_text(before.replace(disabled, ""), encoding="utf-8")
    shutil.copyfile(makefile, sources / "Makefile.complete")
    receipt["patch"] = {"operation": "remove exactly one -DHB_TINY compiler flag",
                        "beforeSha256": hashlib.sha256(before.encode()).hexdigest(),
                        "after": describe(makefile)}
    source_before = snapshot(hbjs)
    write_record(receipts / "sources-before.json", source_before)

    environment = {**os.environ, "EMSDK_KEEP_DOWNLOADS": "1"}
    run("install-emsdk", ["python3", str(emsdk / "emsdk.py"), "install", "4.0.13"], emsdk, 600, environment)
    run("activate-emsdk", ["python3", str(emsdk / "emsdk.py"), "activate", "4.0.13"], emsdk, 60, environment)
    write_record(receipts / "toolchain-downloads.json", snapshot(emsdk / "downloads"))
    # Arguments supply paths; the shell source command is fixed, never interpolated.
    shell = 'set -euo pipefail; source "$1/emsdk_env.sh"; em++ --version; make -C "$2" harfbuzz'
    run("compile", ["bash", "-c", shell, "harfbuzz-build", str(emsdk), str(hbjs)], hbjs, 900, environment)
    source_after = [row for row in snapshot(hbjs) if not row["path"].startswith("dist/")]
    write_record(receipts / "sources-after.json", source_after)
    if source_before != source_after:
        raise RuntimeError("HarfBuzz source changed during compilation")
    receipt["sourceUnchangedDuringBuild"] = True
    for name in ("harfbuzz.js", "harfbuzz.wasm"):
        shutil.copyfile(hbjs / "dist" / name, runtime / name)
    # The official published JS bridge uses the exact same ABI and release source.
    shutil.copyfile(npm / "dist/index.mjs", runtime / "index.mjs")
    shutil.copyfile(hbjs / "LICENSE", runtime / "LICENSE.harfbuzzjs")
    shutil.copyfile(hb / "COPYING", runtime / "LICENSE.harfbuzz")
    shutil.copyfile(emsdk / "upstream/emscripten/LICENSE", runtime / "LICENSE.emscripten")
    write_record(runtime / "package.json", {"type": "module", "private": True})
    smoke = 'import * as hb from "./index.mjs"; console.log(JSON.stringify({version: hb.versionString(), blob: typeof hb.Blob, shape: typeof hb.shape})); if(typeof hb.Blob!=="function"||typeof hb.shape!=="function") process.exit(1);'
    run("load-generated-runtime", ["node", "--input-type=module", "-e", smoke], runtime)
    receipt["runtime"] = snapshot(runtime)
    receipt["status"] = "built"
except BaseException as error:
    receipt["status"] = "failed"
    receipt["error"] = str(error)
    raise
finally:
    write_record(receipts / "build.json", receipt)
