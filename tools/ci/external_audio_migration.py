"""Return referenced external audio through the patched Jellyfin native route."""
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.error


def verify_external_audio(root, dll, jellyfin, emby):
    work = root / "external-audio"
    work.mkdir()
    old, accessible, template = (work / name for name in ("old-mount", "mounted", "template"))
    emby_root, manager, returned = (work / name for name in ("emby", "manager", "returned"))
    old.mkdir()
    movies = ["Films/First/Feature (2024).mkv", "Films/Second/Other (2025).mkv"]
    tracks = [str(Path(movie).with_name("audio.deu.mka")) for movie in movies]
    unrelated = "Music/audio.deu.mka"
    idx, sub = ("Films/First/Feature (2024).eng." + ext for ext in ("idx", "sub"))

    def ffmpeg(*args):
        subprocess.run([os.environ["MEDIAMANAGER_FFMPEG"], "-hide_banner", "-loglevel", "error", *map(str, args)], check=True)

    for relative in movies:
        movie = old / relative
        movie.parent.mkdir(parents=True)
        ffmpeg("-f", "lavfi", "-i", "color=blue:size=64x48:rate=5", "-f", "lavfi", "-i", "sine=frequency=440",
               "-t", "6", "-c:v", "mpeg4", "-c:a", "aac", movie)
    (old / unrelated).parent.mkdir()
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=1320", "-t", "3", "-c:a", "flac", old / unrelated)
    target_user = jellyfin(dll, template, fresh=True)["userId"]
    package = Path(os.environ["MEDIAMANAGER_EMBY_REFERENCE_ROOT"])
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with emby(package, emby_root, port, initialize=True) as (call, account):
        for name, folder, kind in (("Films", "Films", "movies"), ("Music", "Music", "music")):
            options = {"PathInfos": [{"Path": str(old / folder)}], "EnableRealtimeMonitor": False,
                       "EnableInternetProviders": False, "SaveLocalMetadata": False, "MetadataSavers": []}
            call(f"/Library/VirtualFolders?name={name}&collectionType={kind}&refreshLibrary=true", "POST", {"LibraryOptions": options})
        expected = {str(old / relative) for relative in [*movies, unrelated]}
        for _ in range(160):
            items = call(f"/Users/{account}/Items?Recursive=true&IncludeItemTypes=Movie,Audio&Fields=Path")["Items"]
            if expected <= {item.get("Path") for item in items}:
                break
            time.sleep(.5)
        else:
            raise AssertionError(f"Official Emby did not scan the mounted fixture: {items}")
    with sqlite3.connect(emby_root / "data/library.db") as db:
        db.row_factory = sqlite3.Row
        emby_ids = [db.execute("SELECT Id FROM MediaItems WHERE Path=?", (str(old / movie),)).fetchone()[0] for movie in movies]
        for index, (item, name) in enumerate(zip(emby_ids, tracks)):
            original = dict(db.execute("SELECT * FROM MediaStreams2 WHERE ItemId=? AND StreamType=1 LIMIT 1", (item,)).fetchone())
            external = {**original, "StreamIndex": 7, "Codec": "flac", "Language": "ger", "IsExternal": 1, "IsDefault": 0,
                        "Path": str(old / name) if index == 0 else Path(name).name}
            sql = "INSERT INTO MediaStreams2(" + ",".join('"' + column + '"' for column in external) + ") VALUES("
            sql += ",".join("?" for _ in external) + ")"
            db.execute(sql, tuple(external.values()))
            if index == 0:
                subtitle = {**external, "StreamIndex": 8, "StreamType": 3, "Codec": "dvd_subtitle", "Language": "eng", "Path": str(old / idx)}
                db.execute(sql, tuple(subtitle.values()))
    for relative, frequency in zip(tracks, (880, 990)):
        ffmpeg("-f", "lavfi", "-i", f"sine=frequency={frequency}", "-t", "6", "-c:a", "flac", old / relative)
    (old / idx).write_text("# VobSub index file, v7 (do not modify this line!)\nid: en, index: 0\n")
    (old / sub).write_bytes(bytes.fromhex("000001ba44ff1023"))
    old.rename(accessible)
    assert not old.exists()
    mounts, target_mounts, roots, identities = (work / (name + ".json") for name in ("mounts", "target-mounts", "roots", "ids"))
    for file, location in ((mounts, old), (target_mounts, accessible)):
        file.write_text(json.dumps({"mounts": [{"mountId": "films", "identityRoot": str(location),
            "accessRoot": "/mounted-asset-fixture", "pathStyle": "posix", "caseSensitive": True, "returnPolicy": "required"}]}))
    roots.write_text(json.dumps([{"id": "media", "identityRoot": str(old), "directory": str(accessible)}]))
    identities.write_text(json.dumps({"users": {account: target_user}}))
    schema = "external_audio_roundtrip"

    def command(name, *args):
        return json.loads(subprocess.check_output(["node", "tools/database/" + name + ".js", *map(str, args),
            "--schema", schema, "--postgres-url-env", "MEDIAMANAGER_TEST_POSTGRES"], text=True))

    result = command("emby", "import", "--source", emby_root, "--output", manager, "--template", template,
                     "--identity-map", identities, "--mount-contract", mounts, "--asset-roots", roots)
    issues = json.loads(Path(result["report"]).read_text())["issues"]
    assert not [i for i in issues if i["field"] == "Streams" and i["status"] in ("external", "missing")], issues
    for relative in [*tracks, idx, sub]:
        assert (manager / "data/metadata/migration-assets/media" / relative).read_bytes() == (accessible / relative).read_bytes()
    assert not (manager / "data/metadata/migration-assets/media" / unrelated).exists()
    native_db = work / "mounted-jellyfin.db"
    assert command("export-jellyfin", "--output", native_db, "--target-mount-contract", target_mounts)["verified"]
    database = manager / "data/data/jellyfin.db"
    for suffix in ("-wal", "-shm", "-journal"):
        Path(str(database) + suffix).unlink(missing_ok=True)
    native_db.replace(database)
    with sqlite3.connect(database) as db:
        items = [db.execute("SELECT Id FROM BaseItems WHERE Path=?", (str(accessible / movie),)).fetchone()[0] for movie in movies]
        assert db.execute("SELECT StreamIndex,StreamType,Path FROM MediaStreamInfos WHERE ItemId=? AND IsExternal=1 ORDER BY StreamIndex", (items[0],)).fetchall() == [
            (7, 0, "%MetadataPath%/migration-assets/media/" + tracks[0]), (8, 2, "%MetadataPath%/migration-assets/media/" + idx)]
    expected_bytes = [(accessible / name).read_bytes() for name in tracks]
    observations = []

    def native(get, user):
        for index, item in enumerate(items):
            response = get(f"/Items/{item}/PlaybackInfo?userId={user}")
            selected = next(source for source in response["MediaSources"] if source["Id"].lower() == item.replace("-", "").lower())
            assert selected["Path"] == str(accessible / movies[index]), selected
            stream = next(stream for stream in selected["MediaStreams"] if stream["Index"] == 7)
            assert stream["Type"] == "Audio" and stream["IsExternal"] and stream["Language"] in ("ger", "deu"), stream
            route = f"/Videos/{item}/{selected['Id']}/Audios/7/Stream.mka"
            status, _, body = get(route, raw=True)
            assert status == 200 and body == expected_bytes[index] and body != expected_bytes[1-index]
            status, headers, body = get(route, raw=True, headers={"Range": "bytes=7-31"})
            assert status == 206 and body == expected_bytes[index][7:32]
            assert headers["Content-Range"] == f"bytes 7-31/{len(expected_bytes[index])}"
            for source_id, stream_index in ((items[1-index].replace("-", "").lower(), 7), (selected["Id"], 8)):
                try:
                    get(f"/Videos/{item}/{source_id}/Audios/{stream_index}/Stream.mka", raw=True)
                except urllib.error.HTTPError as error:
                    assert error.code == 404, error.code
                else:
                    raise AssertionError("A different media source or stream was served")
            observations.append({"mediaSourceId": selected["Id"], "streamIndex": stream["Index"],
                                 "language": stream["Language"], "sha256": sha256(expected_bytes[index]).hexdigest(), "rangeStatus": status})

    # The pinned Jellyfin build routes local media through its own loopback proxy.
    proxy_tracks = [manager / "data/metadata/migration-assets/media" / track for track in tracks]
    with subprocess.Popen(["node", "tools/ci/migration-media-proxy.mjs", *proxy_tracks,
                           *(accessible / movie for movie in movies)], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as proxy:
        try:
            assert proxy.stdout.readline().strip() == "ready"
            jellyfin(dll, manager, fresh=False, inspect_playback=native)
        finally:
            proxy.stdin.close()
            proxy_report = proxy.stdout.read().strip()
            assert proxy.wait(timeout=20) == 0, proxy_report
    requests = json.loads(proxy_report)
    assert not requests["errors"], requests
    for track in proxy_tracks:
        reads = [entry for entry in requests["requests"] if entry.get("filename") == str(track)]
        assert [(entry["range"], entry["status"]) for entry in reads] == [(None, 200), ("bytes=7-31", 206)], reads
    command("emby", "export", "--source", manager, "--output", returned)
    for relative in [*tracks, idx, sub]:
        assert (returned / "metadata/migration-assets/media" / relative).read_bytes() == (accessible / relative).read_bytes()
    (root / "results/external-audio.json").write_text(json.dumps({"targetNative": observations,
        "unreachableOriginalMount": True, "unreferencedMainAudioExcluded": True, "pairedSubtitles": True}, indent=2) + "\n")
