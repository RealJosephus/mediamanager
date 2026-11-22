"""Verify authoritative companion recovery, conflicts, and resumable publication."""
from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess


V2 = "introskipper-v2.db"
LEGACY = "introskipper.db"
CACHE = "introskipper-cache.db"
MANUAL = "76968930-36BC-4736-BC3F-33E753020064"
DELETED = "334ACDD9-219B-4A6F-8D02-FC98A9F33BD6"
DATA = Path("data/data/introskipper")
ORIGIN = Path(".mediamanager-exchange/origin")


def verify_private_copies(work, case, schema, command, pg, dll, jellyfin, movie, start, end):
    helper = "tools/ci/skipper-private-migration.mjs"
    observed = {}

    def invoke(mode, *args, expected=0):
        result = subprocess.run(["node", helper, mode, *map(str, args)], check=False)
        assert result.returncode == expected, (mode, result.returncode)

    def clone(name):
        target = work / (name + "-source")
        shutil.copytree(case, target, ignore=lambda folder, names: {"introskipper"}
                        if Path(folder) == case / DATA.parent and "introskipper" in names else set())
        (target / DATA).mkdir()
        return target

    def seeded(filename, ddl):
        with closing(sqlite3.connect(filename)) as db, db:
            db.executescript(ddl)

    def read_manual(filename):
        with closing(sqlite3.connect(filename)) as db:
            return db.execute("SELECT EndTicks,Source FROM Segments WHERE Id=?", (MANUAL,)).fetchone()

    def export(source, outgoing):
        return command("emby", "export", "--source", source, "--output", outgoing, *pg(schema))

    def expect_editor(instance, ticks, disabled):
        def native(get, user):
            selected = get("/MediaSegments/" + movie)["Items"]
            assert [(s["Type"], s["StartTicks"], s["EndTicks"]) for s in selected] == [("Intro", start, ticks)], selected
            rows = {row["Id"].replace("-", "").upper(): row for row in get(f"/Episode/{movie}/Segments?includeSuppressed=true")}
            manual, deleted = (rows[id.replace("-", "")] for id in (MANUAL, DELETED))
            assert manual["Source"] == "User" and not manual["Suppressed"] and round(manual["End"] * 1e7) == ticks, rows
            assert deleted["Suppressed"], rows
            flags = get(f"/Intros/DisabledItems/{movie}")
            assert (movie.replace("-", "").lower() in {id.replace("-", "").lower() for id in flags}) is disabled, flags
        jellyfin(dll, instance, fresh=False, inspect_playback=native)

    for name in ("empty", "cache-only", "legacy-only"):
        variant = clone(name)
        if name == "cache-only":
            seeded(variant / DATA / CACHE, "CREATE TABLE OnlyCache(Value TEXT); INSERT INTO OnlyCache VALUES('local cache');")
        if name == "legacy-only":
            seeded(variant / DATA / LEGACY, f"CREATE TABLE DbSegment(ItemId TEXT,Type INTEGER,Start REAL,End REAL,IsUserProvided INTEGER);"
                   f"INSERT INTO DbSegment VALUES('{movie}',0,1,4,1);")
        outgoing = work / (name + "-emby")
        exported = export(variant, outgoing)
        archived = outgoing / ORIGIN / DATA
        assert read_manual(archived / V2) == (end+11, 5)
        issues = json.loads(Path(exported["report"]).read_text())["issues"]
        assert not [issue for issue in issues if issue["field"] == "IntroSkipper" and issue["status"] == "conflict"], issues
        if name == "cache-only":
            with closing(sqlite3.connect(archived / CACHE)) as db:
                assert db.execute("SELECT Value FROM OnlyCache").fetchone() == ("local cache",)
        if name == "legacy-only":
            with closing(sqlite3.connect(archived / LEGACY)) as db:
                assert db.execute("SELECT End FROM DbSegment").fetchone() == (4.0,)
            returned = work / "coexisting-return"
            command("emby", "import", "--source", outgoing, "--output", returned, *pg("skip_coexisting"))
            expect_editor(returned, end+11, False)
        observed[name] = True

    interrupted_main, interrupted_private = work / "interrupted.db", work / "interrupted-private"
    args = ["--output", interrupted_main, "--intro-skipper-output", interrupted_private, *pg(schema)]
    invoke("interrupt-export", *args, expected=73)
    assert interrupted_main.is_file() and not interrupted_private.exists()
    assert len(list(work.glob(".intro-skipper-*.pending"))) == 1
    assert command("export-jellyfin", *args)["verified"]
    assert not list(work.glob(".intro-skipper-*.pending"))
    restored = {file.name: sha256(file.read_bytes()).hexdigest() for file in interrupted_private.iterdir()}
    assert command("export-jellyfin", *args)["verified"]
    assert restored == {file.name: sha256(file.read_bytes()).hexdigest() for file in interrupted_private.iterdir()}
    observed["recoveredMainAndCompanions"] = True

    pg_copy = work / "postgres-newer.db"
    shutil.copyfile(interrupted_private / V2, pg_copy)
    with closing(sqlite3.connect(pg_copy)) as db, db:
        db.execute("UPDATE Segments SET EndTicks=? WHERE Id=?", (end+31, MANUAL))
    invoke("update-pg-copy", schema, pg_copy)
    outgoing = work / "postgres-newer-emby"
    export(case, outgoing)
    assert read_manual(outgoing / ORIGIN / DATA / V2) == (end+31, 5)
    observed["postgresChangedOnly"] = True

    changed = work / "both-changed-source"
    shutil.copytree(case, changed)
    outgoing = work / "both-changed-emby"
    with closing(sqlite3.connect(changed / DATA / V2)) as wal:
        assert wal.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        wal.execute("PRAGMA wal_autocheckpoint=0")
        wal.execute("UPDATE Segments SET EndTicks=? WHERE Id=?", (end+45, MANUAL))
        wal.execute("INSERT INTO DisabledItems(ItemId) VALUES(?)", (movie,))
        wal.commit()
        with closing(sqlite3.connect((changed / DATA / V2).as_uri() + "?immutable=1", uri=True)) as db:
            assert db.execute("SELECT EndTicks FROM Segments WHERE Id=?", (MANUAL,)).fetchone() == (end+11,)
        exported = export(changed, outgoing)
    issues = json.loads(Path(exported["report"]).read_text())["issues"]
    conflict = next(issue["evidence"] for issue in issues if issue["field"] == "IntroSkipper" and issue["status"] == "conflict")
    assert conflict["local"]["logical"] != conflict["postgres"]["logical"] and conflict["selected"] == "local", conflict
    assert read_manual(outgoing / conflict["postgresCopy"]) == (end+31, 5)
    assert read_manual(outgoing / ORIGIN / DATA / V2) == (end+45, 5)
    returned = work / "conflict-return"
    args = ["--source", outgoing, "--output", returned, *pg("skip_conflict_return")]
    invoke("interrupt-import", *args, expected=73)
    assert not returned.exists()
    command("emby", "import", *args)
    expect_editor(returned, end+45, True)
    observed["divergentCopiesAndWal"] = conflict
    observed["recoveredEmbyPublication"] = True
    (work.parents[1] / "results/intro-skipper-private.json").write_text(json.dumps(observed, indent=2) + "\n")
