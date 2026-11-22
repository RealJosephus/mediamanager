"""Read typed playback markers through each native HTTP API, using a real scanned video."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time
import zipfile


def verify_chapter_markers(root, dll, jellyfin, emby, password):
    work = root / "chapter-markers"
    work.mkdir()
    template = work / "jellyfin-template"
    target_user = jellyfin(dll, template, fresh=True)["userId"]
    media = work / "media"
    media.mkdir()
    film = media / "Marker exchange (2024).mkv"
    captions = work / "fixture.srt"
    captions.write_text("1\n00:00:01,000 --> 00:00:02,000\nFixture\n")
    subprocess.run([os.environ["MEDIAMANAGER_FFMPEG"], "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=blue:size=64x48:rate=5", "-f", "lavfi", "-i", "sine=frequency=440",
                    "-i", str(captions), "-map", "0:v", "-map", "1:a", "-map", "2:s",
                    "-t", "10", "-c:v", "mpeg4", "-c:a", "aac", "-c:s", "srt", str(film)], check=True)
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
        dto = call(f"/Users/{account}/Items/{item}?Fields=Chapters,MediaStreams,Path")
        streams = [(s["Index"], s["Type"]) for s in dto["MediaStreams"]]
        assert streams == [(0, "Video"), (1, "Audio"), (2, "Subtitle")], streams
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
    if work.name == "fixed":
        verify_skipper_sources(command, pg, work, manager, movie, storage, username, password, start, new_end,
                               dll, jellyfin, emby, package, port, item, exchange, native_chapters)
    return {"version": json.loads((package / "receipts/reference-input.json").read_text())["version"],
            "embyBeforeAndAfter": True, "mediaManagerApi": True, "jellyfinWithAndWithoutProvider": True,
            "preservedCustomMarkerName": True, "changedIntroEndTicks": new_end, "deletedCredits": True}


def verify_skipper_sources(command, pg, work, original, movie, storage, username, password, start, end,
                          dll, jellyfin, emby, package, port, emby_item, exchange, native_chapters):
    case = work / "plugin-transfer"
    shutil.copytree(original, case)
    dbfile = case / "data/data/jellyfin.db"
    state = case / ".mediamanager-exchange"
    def import_to(schema):
        return command("import-jellyfin", "--source", dbfile, "--instance-binding", state / "binding.json",
                       "--mount-contract", state / "mounts.json", *pg(schema))
    def inspect(schema, before, after):
        subprocess.run(["node", "tools/ci/verify-marker-api-migration.mjs", str(case), schema, str(storage), username, movie,
                        json.dumps(before), json.dumps(after)], env={**os.environ, "MM_FIXTURE_PASSWORD": password}, check=True)
    with sqlite3.connect(dbfile) as db:
        runtime = db.execute("SELECT RunTimeTicks FROM BaseItems WHERE Id=?", (movie,)).fetchone()[0]
        db.executemany("INSERT INTO Chapters(ItemId,ChapterIndex,StartPositionTicks,Name) VALUES(?,?,?,?)",
                       [(movie,1,70000003,"End Credits"),(movie,2,91000005,"Stinger")])
    schema = "marker_analysis_cold"
    assert import_to(schema)["verified"]
    intro = ["Intro",start,end]
    inspect(schema,[intro],[intro,["Outro",70000003,91000005]])
    after_scan = work / "analysis-reopened.db"
    assert command("export-jellyfin","--output",after_scan,*pg(schema))["verified"]
    with sqlite3.connect(after_scan) as db:
        assert db.execute("SELECT StartTicks,EndTicks FROM MediaSegments WHERE Type=4 AND ItemId=?", (movie,)).fetchone() == (70000003,91000005)
    installed = case / "data/plugins/Intro Skipper_12.0.7.0"
    installed.mkdir(parents=True)
    with zipfile.ZipFile(os.environ["MEDIAMANAGER_SKIPPER_ZIP"]) as archive:
        (installed / "IntroSkipper.dll").write_bytes(archive.read("IntroSkipper.dll"))
    (installed / "meta.json").write_text(json.dumps({"guid":"c83d86bb-a1e0-4c35-a113-e2101cf4ee6b",
        "name":"Intro Skipper","version":"12.0.7.0","targetAbi":"12.4.0.0","assemblies":["IntroSkipper.dll"],"status":"Active"}))
    def installed_and_active(get, user):
        plugins = [(p["Name"], p["Status"]) for p in get("/Plugins")]
        assert ("Intro Skipper", "Active") in plugins, plugins
        assert isinstance(get(f"/Episode/{movie}/Segments?includeSuppressed=true"), list)
    jellyfin(dll, case, fresh=False, inspect_playback=installed_and_active)
    private = dbfile.parent / "introskipper"
    assert (private / "introskipper-v2.db").is_file(), "The upstream plugin did not initialize its private database"
    with sqlite3.connect(private / "introskipper-v2.db") as db:
        db.executescript("CREATE TABLE OpaqueState(Value BLOB); INSERT INTO OpaqueState VALUES(X'00FF10');")
        db.executemany("INSERT INTO Segments(Id,ItemId,Type,StartTicks,EndTicks,Source,State,ConfigHash,CreatedAt,UpdatedAt) VALUES(?,?,?,?,?,?,?,'original','2026-01-01','2026-01-01')",
            [("76968930-36BC-4736-BC3F-33E753020064",movie,0,start,end+11,5,0),
             ("334ACDD9-219B-4A6F-8D02-FC98A9F33BD6",movie,1,70000003,91000005,2,1)])
    with sqlite3.connect(dbfile) as db:
        db.execute("DELETE FROM MediaSegments WHERE ItemId=?", (movie,))
    schema = "marker_skipper_v2"
    assert "introskipper-v2.db" in import_to(schema)["introSkipperDatabases"]
    manual = [["Intro",start,end+11]]
    inspect(schema,manual,manual)
    restored = work / "restored-skipper"
    assert command("export-jellyfin","--output",work/"with-skipper.db","--intro-skipper-output",restored,*pg(schema))["verified"]
    with sqlite3.connect(restored / "introskipper-v2.db") as db:
        assert db.execute("SELECT Source,State,EndTicks FROM Segments WHERE ItemId=? ORDER BY Type", (movie,)).fetchall() == [(5,0,end+11),(2,1,91000005)]
        assert db.execute("SELECT Value FROM OpaqueState").fetchone()[0] == bytes([0,255,16])
    native_emby, native_jellyfin = work/"skipper-to-emby", work/"skipper-back"
    exchange("export",case,native_emby,schema)
    with emby(package, native_emby, port) as (call, account):
        assert ("IntroEnd",end+11,"Intro End") in native_chapters(call, account, emby_item)
    with sqlite3.connect(native_emby/"data/library.db") as db:
        changed = db.execute("UPDATE Chapters3 SET StartPositionTicks=? WHERE ItemId=? AND MarkerType=2", (end+23, emby_item))
        assert changed.rowcount == 1
        index = db.execute("SELECT coalesce(max(ChapterIndex),-1)+1 FROM Chapters3 WHERE ItemId=?", (emby_item,)).fetchone()[0]
        db.execute("INSERT INTO Chapters3(ItemId,ChapterIndex,MarkerType,StartPositionTicks,Name) VALUES(?,?,3,95000001,'Credits Start')", (emby_item,index))
    exchange("import",native_emby,native_jellyfin,"marker_skipper_native_return","--credits-end","runtime")
    with sqlite3.connect(native_jellyfin/"data/data/introskipper/introskipper-v2.db") as db:
        assert db.execute("SELECT EndTicks,Source FROM Segments WHERE Id='76968930-36BC-4736-BC3F-33E753020064'").fetchone() == (end+23,5)
        assert db.execute("SELECT StartTicks,EndTicks,Source FROM Segments WHERE ItemId=? AND Type=1 AND State=0", (movie,)).fetchone() == (95000001,runtime,5)
    def final_native_read(get, user):
        installed_and_active(get, user)
        segments = get("/MediaSegments/" + movie)["Items"]
        assert [(s["Type"],s["StartTicks"],s["EndTicks"]) for s in segments] == [("Intro",start,end+23),("Outro",95000001,runtime)], segments
        assert len(get(f"/Episode/{movie}/Segments?includeSuppressed=true")) == 3
    jellyfin(dll,native_jellyfin,fresh=False,inspect_playback=final_native_read)
