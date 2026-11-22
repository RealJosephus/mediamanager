"""Read typed playback markers through each native HTTP API, using a real scanned video."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time


def verify_chapter_markers(root, dll, jellyfin, emby, password):
    work = root / "chapter-markers"
    work.mkdir()
    template = work / "jellyfin-template"
    target_user = jellyfin(dll, template, fresh=True)["userId"]
    media = work / "media"
    media.mkdir()
    film = media / "Marker exchange (2024).mkv"
    subprocess.run([os.environ["MEDIAMANAGER_FFMPEG"], "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=blue:size=64x48:rate=5", "-t", "10", "-c:v", "mpeg4", "-an", str(film)], check=True)
    virtual = "/marker-fixture"
    mounts = work / "mounts.json"
    mounts.write_text(json.dumps({"mounts": [{"mountId": "markers", "identityRoot": str(media), "accessRoot": virtual,
                                            "pathStyle": "posix", "caseSensitive": True, "returnPolicy": "required"}]}))
    storage = work / "storage.json"
    storage.write_text(json.dumps({
        "instances": [{"id": "fixture", "type": "local", "config": {"root": str(media), "writable": False}}],
        "mounts": [{"path": virtual, "instanceId": "fixture", "capabilities": {}}],
        "prefixes": [{"identityRoot": str(media), "accessRoot": virtual, "style": "posix", "caseSensitive": True,
                      "purpose": "library", "returnAccess": "CI fixture"}]}))
    results = {}
    for channel, var in (("fixed", "MEDIAMANAGER_EMBY_ALTERNATE_ROOT"), ("rolling", "MEDIAMANAGER_EMBY_REFERENCE_ROOT")):
        case = work / channel
        case.mkdir()
        results[channel] = marker_roundtrip(case, Path(os.environ[var]), dll, jellyfin, emby, template,
                                              target_user, film, mounts, storage, password)
        (root / "results/chapter-markers.json").write_text(json.dumps(results, indent=2) + "\n")


def marker_roundtrip(work, package, dll, jellyfin, emby, template, target_user, film, mounts, storage, password):
    def command(name, *args):
        result = subprocess.check_output(["node", "tools/database/" + name + ".js", *map(str, args)], text=True)
        return json.loads(result)

    def pg(schema):
        return ["--schema", schema, "--postgres-url-env", "MEDIAMANAGER_TEST_POSTGRES"]

    def exchange(mode, source, dest, schema, *extra):
        result = command("emby", mode, "--source", source, "--output", dest, *pg(schema), *extra)
        report = json.loads(Path(result["report"]).read_text())["issues"]
        assert not [i for i in report if i["status"] == "conflict" and i["field"] in ("IntroSkip", "CreditsSkip", "Chapters")], report
        return report

    def native_chapters(call, account, item):
        dto = call(f"/Users/{account}/Items/{item}?Fields=Chapters,Path")
        return [(c.get("MarkerType") or "Chapter", c.get("StartPositionTicks", 0), c.get("Name")) for c in dto["Chapters"]]

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    original, manager, returned = (work / p for p in ("emby", "manager", "emby-return"))
    with emby(package, original, port, initialize=True) as (call, account):
        library = {"PathInfos": [{"Path": str(film.parent)}], "EnableRealtimeMonitor": False,
                   "EnableInternetProviders": False, "SaveLocalMetadata": False, "MetadataSavers": []}
        call("/Library/VirtualFolders?name=Markers&collectionType=movies&refreshLibrary=true", "POST", {"LibraryOptions": library})
        for _ in range(180):
            movies = call(f"/Users/{account}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path")["Items"]
            item = next((m["Id"] for m in movies if m.get("Path") == str(film)), None)
            if item:
                break
            time.sleep(.5)
        assert item, "Official Emby did not scan the movie"
    mapping = work / "identities.json"
    mapping.write_text(json.dumps({"users": {account: target_user}}))
    start, finish, credits = 10000001, 34000003, 82000009
    points = [(0, 0, "Scene"), (1, start, "My opening"), (2, finish, "Intro End"), (3, credits, "Credits Start")]
    with sqlite3.connect(original / "data/library.db") as db:
        key, runtime = db.execute("SELECT Id,RunTimeTicks FROM MediaItems WHERE Path=?", (str(film),)).fetchone()
        assert runtime and runtime > credits
        db.execute("DELETE FROM Chapters3 WHERE ItemId=?", (key,))
        db.executemany("INSERT INTO Chapters3(ItemId,ChapterIndex,StartPositionTicks,Name,MarkerType) VALUES(?,?,?,?,?)",
                       [(key, index, ticks, label, kind) for index, (kind, ticks, label) in enumerate(points)])
    def points_in_emby(end_ticks, include_credits):
        rows = [("Chapter", 0, "Scene"), ("IntroStart", start, "My opening"), ("IntroEnd", end_ticks, "Intro End")]
        return rows + ([("CreditsStart", credits, "Credits Start")] if include_credits else [])
    with emby(package, original, port) as (call, account):
        assert native_chapters(call, account, item) == points_in_emby(finish, True)
    schema = "marker_" + work.name
    report = exchange("import", original, manager, schema, "--template", template, "--identity-map", mapping,
                      "--mount-contract", mounts, "--credits-end", "runtime")
    assert any(i["status"] == "inferred" and i["field"] == "CreditsSkip" for i in report), report
    database = manager / "data/data/jellyfin.db"
    exported = work / "pg-return.db"
    assert command("export-jellyfin", "--output", exported, *pg(schema))["verified"]
    for suffix in ("-wal", "-shm", "-journal"):
        Path(str(database) + suffix).unlink(missing_ok=True)
    exported.replace(database)
    with sqlite3.connect(database) as db:
        movie = db.execute("SELECT Id FROM BaseItems WHERE Path=?", (str(film),)).fetchone()[0]
        id_before = db.execute("SELECT Id,SegmentProviderId FROM MediaSegments WHERE Type=5 AND ItemId=?", (movie,)).fetchone()
        assert id_before
    expected = [["Intro", start, finish], ["Outro", credits, runtime]]
    username = (manager / "probe-user.txt").read_text()
    subprocess.run(["node", "tools/ci/verify-marker-api-migration.mjs", str(manager), schema, str(storage), username,
                    movie, json.dumps(expected)], env={**os.environ, "MM_FIXTURE_PASSWORD": password}, check=True)
    def check(expected_segments):
        def verify(get, user):
            segments = get("/MediaSegments/" + movie)["Items"]
            if [[s["Type"], s["StartTicks"], s["EndTicks"]] for s in segments] != expected_segments:
                with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as reader:
                    rows = reader.execute("SELECT Type,StartTicks,EndTicks,SegmentProviderId FROM MediaSegments WHERE ItemId=?", (movie,)).fetchall()
                raise AssertionError({"actual": segments, "expected": expected_segments, "rows": rows,
                    "plugins": [(p.get("Name"), p.get("Status")) for p in get("/Plugins")],
                    "programData": get("/System/Info").get("ProgramDataPath")})
            dto = get(f"/Users/{user}/Items/{movie}")
            assert [(c.get("Name"), c.get("StartPositionTicks", 0)) for c in dto["Chapters"]] == [("Scene", 0)], dto.get("Chapters")
        return verify
    # The native Jellyfin API filters stored rows by installed, enabled providers.
    jellyfin(dll, manager, fresh=False, inspect_playback=check([]))
    plugins = manager / "data/plugins/Emby Chapter Markers_1.0.0.0"
    plugins.mkdir(parents=True)
    shutil.copy2(os.environ["MEDIAMANAGER_MARKER_PLUGIN"], plugins)
    shutil.copy2(Path(os.environ["MEDIAMANAGER_MARKER_PLUGIN"]).with_name("meta.json"), plugins)
    jellyfin(dll, manager, fresh=False, inspect_playback=check(expected))
    new_end = finish + 7
    with sqlite3.connect(database) as db:
        db.execute("UPDATE MediaSegments SET EndTicks=? WHERE Id=?", (new_end, id_before[0]))
        db.execute("DELETE FROM MediaSegments WHERE ItemId=? AND Type=4", (movie,))
    jellyfin(dll, manager, fresh=False, inspect_playback=check([["Intro", start, new_end]]))
    state = manager / ".mediamanager-exchange"
    edited = schema + "_edited"
    assert command("import-jellyfin", "--source", database, "--instance-binding", state / "binding.json",
                   "--mount-contract", state / "mounts.json", *pg(edited))["verified"]
    exchange("export", manager, returned, edited)
    with emby(package, returned, port) as (call, account):
        actual = native_chapters(call, account, item)
        assert actual == points_in_emby(new_end, False), actual
    return {"version": json.loads((package / "receipts/reference-input.json").read_text())["version"],
            "embyBeforeAndAfter": True, "mediaManagerApi": True, "jellyfinWithAndWithoutProvider": True,
            "preservedCustomMarkerName": True, "changedIntroEndTicks": new_end, "deletedCredits": True}
