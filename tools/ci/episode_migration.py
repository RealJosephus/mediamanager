"""Read migrated episode ownership from the native API and the first-party detection task."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time


def verify_episodes(root, dll, jellyfin, emby, password):
    work = root / "episodes"
    work.mkdir()
    media, audio, template = (work / name for name in ("media", "audio", "template"))
    audio.mkdir()
    probe = "tools/ci/verify-episode-api-migration.mjs"
    subprocess.run(["node", probe, "--write-audio", audio], check=True)
    episodes = {
        "first": (1, 1), "second": (1, 2), "moved": (1, 3), "special1": (0, 1), "special2": (0, 2),
        "fallback": (2, 1), "ambiguous": (1, 4), "orphan": (1, 5), "third": (3, 1), "fourth": (4, 1),
    }
    paths = {}
    for name, (season, number) in episodes.items():
        directory = media / "Exchange Series" / f"Season {season:02}"
        directory.mkdir(parents=True, exist_ok=True)
        paths[name] = directory / f"Exchange Series - S{season:02}E{number:02}.mkv"
        if name in ("ambiguous", "orphan", "third", "fourth"):
            shutil.copyfile(paths["first" if name in ("ambiguous", "orphan") else "fallback"], paths[name])
        else:
            subprocess.run([os.environ["MEDIAMANAGER_FFMPEG"], "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", "color=black:size=64x48:rate=3", "-i", audio / (name + ".wav"),
                            "-c:v", "mpeg4", "-c:a", "flac", "-shortest", paths[name]], check=True)
    access_root = "/episode-fixture"
    mounts = work / "mounts.json"
    mounts.write_text(json.dumps({"mounts": [{"mountId": "episodes", "identityRoot": str(media),
                                            "accessRoot": access_root, "pathStyle": "posix", "caseSensitive": True,
                                            "returnPolicy": "required"}]}))
    storage = work / "storage.json"
    storage.write_text(json.dumps({
        "instances": [{"id": "episodes", "type": "local", "config": {"root": str(media), "writable": False}}],
        "mounts": [{"path": access_root, "instanceId": "episodes", "capabilities": {}}],
        "prefixes": [{"identityRoot": str(media), "accessRoot": access_root, "style": "posix", "caseSensitive": True,
                      "purpose": "library", "returnAccess": "CI fixture"}]}))
    target_user = jellyfin(dll, template, fresh=True)["userId"]
    results = {}
    for channel, env in (("fixed", "MEDIAMANAGER_EMBY_ALTERNATE_ROOT"), ("rolling", "MEDIAMANAGER_EMBY_REFERENCE_ROOT")):
        case = work / channel
        case.mkdir()
        package = Path(os.environ[env])
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        original, manager, returned, repaired, edited = (case / name for name in ("emby", "manager", "return", "repair", "edited"))
        with emby(package, original, port, initialize=True) as (call, account):
            options = {"PathInfos": [{"Path": str(media)}], "EnableRealtimeMonitor": False,
                       "EnableInternetProviders": False, "SaveLocalMetadata": False, "MetadataSavers": []}
            call("/Library/VirtualFolders?name=Episodes&collectionType=tvshows&refreshLibrary=true", "POST", {"LibraryOptions": options})
            for _ in range(180):
                items = call(f"/Users/{account}/Items?Recursive=true&IncludeItemTypes=Episode&Fields=Path")["Items"]
                if {str(location) for location in paths.values()} <= {item.get("Path") for item in items}:
                    break
                time.sleep(.5)
            else:
                raise AssertionError(f"Emby did not discover all episodes: {items}")
        mapping = case / "identities.json"
        mapping.write_text(json.dumps({"users": {account: target_user}}))
        with sqlite3.connect(original / "data/library.db") as db:
            emby_items = {name: db.execute("SELECT Id,ParentId,SeriesId FROM MediaItems WHERE Path=? AND type=8",
                                           (str(location),)).fetchone() for name, location in paths.items()}
            series = emby_items["first"][2]
            seasons = {number: emby_items[name][1] for number, name in enumerate(
                ("special1", "first", "fallback", "third", "fourth"))}
            assert series and len(set(seasons.values())) == 5 and None not in seasons.values(), emby_items
            db.execute("UPDATE MediaItems SET Name='Shared season name' WHERE Id IN (?,?)", (seasons[1], seasons[2]))
            db.execute("UPDATE MediaItems SET IndexNumber=3 WHERE Id=?", (seasons[4],))
            db.execute("UPDATE MediaItems SET ParentId=?,ParentIndexNumber=3 WHERE Id=?", (series, emby_items["ambiguous"][0]))
            db.execute("UPDATE MediaItems SET ParentId=? WHERE Id=?", (series, emby_items["fallback"][0]))
            db.execute("UPDATE MediaItems SET ParentId=NULL,ParentIndexNumber=NULL WHERE Id=?", (emby_items["orphan"][0],))

        def command(name, schema, *args):
            return json.loads(subprocess.check_output(["node", "tools/database/" + name + ".js", *map(str, args),
                "--schema", schema, "--postgres-url-env", "MEDIAMANAGER_TEST_POSTGRES"], text=True))

        schema = "episodes_" + channel
        before = command("emby", schema, "import", "--source", original, "--output", manager, "--template", template,
                         "--identity-map", mapping, "--mount-contract", mounts)
        command("emby", schema, "export", "--source", manager, "--output", returned)
        shutil.copytree(manager, repaired)
        with sqlite3.connect(repaired / "data/data/jellyfin.db") as db:
            db.execute("UPDATE BaseItems SET SeasonId=NULL, SeasonName=NULL WHERE Path=?", (str(paths["first"]),))
        with sqlite3.connect(returned / "data/library.db") as db:
            db.execute("UPDATE MediaItems SET ParentId=?,ParentIndexNumber=2 WHERE Id=?", (seasons[2], emby_items["moved"][0]))
        after = command("emby", schema + "_edit", "import", "--source", returned, "--output", edited,
                        "--template", repaired, "--mount-contract", mounts)

        def check(instance, schema_name, receipt, moved):
            database = instance / "data/data/jellyfin.db"
            exported = case / (schema_name + ".db")
            assert command("export-jellyfin", schema_name, "--output", exported)["verified"]
            for suffix in ("-wal", "-shm", "-journal"):
                Path(str(database) + suffix).unlink(missing_ok=True)
            exported.replace(database)
            with sqlite3.connect(database) as db:
                rows = {name: db.execute("SELECT Id,ParentId,SeriesId,SeasonId,SeasonName FROM BaseItems WHERE Path=?",
                                         (str(location),)).fetchone() for name, location in paths.items()}
                ids = {name: row[0] for name, row in rows.items()}
                special_season, first_season, second_season = (rows[name][3] for name in ("special1", "first", "fallback"))
                assert all((special_season, first_season, second_season)) and len({special_season, first_season, second_season}) == 3, rows
                assert rows["first"][1] == first_season and rows["second"][3] == first_season, rows
                assert rows["first"][4] == rows["fallback"][4] == "Shared season name", rows
                assert rows["moved"][1] == rows["moved"][3] == (second_season if moved else first_season), rows
                assert rows["special2"][3] == special_season and rows["fallback"][1] == rows["fallback"][2], rows
                assert rows["ambiguous"][3] is None and rows["orphan"][3] is None, rows
                show = rows["first"][2]
                assert show and all(row[2] == show for row in rows.values()), rows
            issues = json.loads(Path(receipt["report"]).read_text())["issues"]
            season_issues = {issue["id"]: issue["reason"] for issue in issues if issue["field"] == "SeasonId"}
            assert "multiple seasons" in season_issues[ids["ambiguous"]], season_issues
            if not moved:
                assert "no confirmed season" in season_issues[ids["orphan"]], season_issues
            first = [ids[name] for name in (("first", "second") if moved else ("first", "second", "moved"))]
            special = [ids["special1"], ids["special2"]]
            second = [ids["fallback"]] + ([ids["moved"]] if moved else [])
            expectation = {"series": show, "seasons": {first_season: first, special_season: special, second_season: second},
                "played": ids["first"], "nextUp": ids["second"],
                "intros": {ids[name]: opening for name, opening in (
                    ("first", 10), ("second", 21), ("moved", None if moved else 12),
                    ("special1", 10), ("special2", 20), ("ambiguous", None), ("orphan", None), ("fallback", None))}}
            expected_file = case / (schema_name + ".json")
            expected_file.write_text(json.dumps(expectation))
            username = (instance / "probe-user.txt").read_text()
            segments = json.loads(subprocess.check_output(["node", probe, instance, schema_name, storage, username,
                expected_file], env={**os.environ, "MM_FIXTURE_PASSWORD": password}, text=True).splitlines()[-1])

            def native(get, user):
                for season, expected_ids in ((first_season, first), (special_season, special)):
                    items = get(f"/Shows/{show}/Episodes?seasonId={season}&userId={user}")["Items"]
                    assert {key(item["Id"]) for item in items} == {key(item) for item in expected_ids}, items
                    assert all(key(item["SeasonId"]) == key(season) for item in items), items
                if moved:
                    items = get(f"/Shows/{show}/Episodes?seasonId={second_season}&userId={user}")["Items"]
                    assert any(key(item["Id"]) == key(ids["moved"]) and key(item["SeasonId"]) == key(second_season)
                               for item in items), items
                get(f"/Users/{user}/PlayedItems/{ids['first']}", post=True)
                next_up = get(f"/Shows/NextUp?seriesId={show}&userId={user}")["Items"]
                assert [key(item["Id"]) for item in next_up] == [key(ids["second"])], next_up
            jellyfin(dll, instance, fresh=False, inspect_playback=native)
            return {"seasons": expectation["seasons"], "seasonIssues": season_issues, "detectedIntros": segments,
                    "nextUp": ids["second"]}

        results[channel] = {"version": json.loads((package / "receipts/reference-input.json").read_text())["version"],
                            "initial": check(manager, schema, before, False),
                            "movedAndRepaired": check(edited, schema + "_edit", after, True)}
        (root / "results/episodes.json").write_text(json.dumps(results, indent=2) + "\n")


def key(id):
    return id.replace("-", "").lower()
