"""Observe real Jellyfin fresh and in-place upgraded SQLite state on a hosted runner."""
import shutil
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import wave
from contextlib import contextmanager

runroot = Path(os.environ["RUNNER_TEMP"])
output = runroot / "results" / "history.json"
password = secrets.token_urlsafe(32)


def run_host(dll, instance, *, fresh, seed_media=False, edit_item=None, expected_favorite=None):
    for name in ("data", "config", "cache", "log", "config/user/Subtitle Edit"):
        (instance / name).mkdir(parents=True, exist_ok=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    (instance / "config/network.xml").write_text(f"""<NetworkConfiguration>
      <InternalHttpPort>{port}</InternalHttpPort><PublicHttpPort>{port}</PublicHttpPort>
      <EnableRemoteAccess>false</EnableRemoteAccess><AutoDiscovery>false</AutoDiscovery>
      <EnableUPnP>false</EnableUPnP><EnableIPv4>true</EnableIPv4><EnableIPv6>false</EnableIPv6>
      <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>""")
    args = ["dotnet", dll, "--nowebclient", "--ffmpeg", os.environ["MEDIAMANAGER_FFMPEG"]]
    for flag, directory in (("--datadir","data"),("--cachedir","cache"),("--configdir","config"),("--logdir","log")):
        args.extend((flag, str(instance / directory)))
    token = ""
    def call(route, body=None, admin=False, post=False, form=False):
        auth = f'MediaBrowser Token="{token}"' if admin else 'MediaBrowser Client="Reference", Device="CI", DeviceId="ci-history", Version="1.0"'
        payload = None if body is None else (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        content_type = "application/x-www-form-urlencoded" if form else "application/json"
        req = urllib.request.Request(f"http://127.0.0.1:{port}"+route, data=payload, headers={"Content-Type":content_type,"Authorization":auth}, method="POST" if post or body is not None else "GET")
        with urllib.request.urlopen(req, timeout=6) as response:
            data = response.read()
            return json.loads(data) if data else None
    env = {**os.environ, "XDG_CONFIG_HOME":str(instance/"config/user")}
    with (instance/"process.log").open("w+") as log:
        proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, cwd=instance, env=env)
        try:
            route = "/Startup/User" if fresh else "/System/Info/Public"
            for _ in range(480):
                if proc.poll() is not None:
                    raise RuntimeError("Jellyfin exited before readiness")
                try:
                    ready = call(route)
                    if ready and ("Name" in ready if fresh else "Id" in ready):
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.25)
            else:
                raise RuntimeError("Jellyfin readiness timed out")
            if fresh:
                username = ready["Name"]
                (instance/"probe-user.txt").write_text(username)
                call("/Startup/User", {"Name":username, "Password":password})
            else:
                username = (instance/"probe-user.txt").read_text()
            token = call("/Users/AuthenticateByName", {"Username":username,"Pw":password})["AccessToken"]
            if fresh:
                call("/Startup/Configuration", {"ServerName":"Reference","UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"})
                call("/Startup/Complete", post=True)
            session = call("/Users/AuthenticateByName", {"Username":username, "Pw":password}, form=True)
            token = session["AccessToken"]
            user_id = session["User"]["Id"]
            info = call("/System/Info", admin=True)
            media_id = edit_item
            if seed_media:
                media = runroot / "jellyfin-music"
                media.mkdir(exist_ok=True)
                album = media / "Test artist" / "Exchange album"
                album.mkdir(parents=True, exist_ok=True)
                with wave.open(str(album / "01 - Exchange.wav"), "wb") as sample:
                    sample.setparams((1, 2, 8000, 0, "NONE", "NONE"))
                    sample.writeframes(bytes(16000))
                options = {"PathInfos":[{"Path":str(media)}], "Enabled":True, "EnableRealtimeMonitor":False, "MetadataSavers":[],
                           "TypeOptions":[{"Type":kind,"MetadataFetchers":[],"ImageFetchers":[]} for kind in ("Audio","MusicAlbum","MusicArtist")]}
                call("/Library/VirtualFolders?name=Exchange&collectionType=music&refreshLibrary=false", {"LibraryOptions":options}, admin=True)
                libraries=call("/Library/VirtualFolders",admin=True)
                assert any(str(media) in library["Locations"] for library in libraries), libraries
                for _ in range(180):
                    scan=next(t for t in call("/ScheduledTasks",admin=True) if t["Key"]=="RefreshLibrary")
                    if scan["State"]=="Idle": break
                    time.sleep(.25)
                call("/ScheduledTasks/Running/"+scan["Id"],admin=True,post=True)
                for _ in range(180):
                    items = call(f"/Users/{user_id}/Items?Recursive=true&IncludeItemTypes=Audio", admin=True)["Items"]
                    if items:
                        media_id = items[0]["Id"]
                        break
                    time.sleep(.5)
                assert media_id, "real native library did not scan the media file"
            if edit_item:
                media_dto = call(f"/Users/{user_id}/Items/{edit_item}", admin=True)
                assert media_dto["Name"] == "PG edited native audio", media_dto["Name"]
                if expected_favorite is None:
                    assert call(f"/Users/{user_id}/FavoriteItems/{edit_item}", admin=True, post=True)["IsFavorite"]
                else:
                    assert media_dto["UserData"]["IsFavorite"] is expected_favorite, media_dto["UserData"]
            absent = "9a53580442fa415380a677243943beee"
            try:
                call(f"/Videos/{absent}/{absent}/Audios/2/Stream.dts", admin=True)
            except urllib.error.HTTPError as error:
                assert error.code == 404 and "Item not found" in error.read().decode(), error.code
            else:
                raise AssertionError("Missing audio item unexpectedly succeeded")
            call("/System/Shutdown", admin=True, post=True)
            if proc.wait(timeout=30) != 0:
                raise RuntimeError("Jellyfin stopped with an error")
            return {"serverId":info["Id"], "version":info["Version"], "formAuthentication":True, "missingAudioTrackStatus":404,
                    "mediaId":media_id, "userId":user_id}
        except BaseException:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=8)
            log.flush()
            log.seek(0)
            diagnostic = log.read()[-6000:].replace(password, "[redacted]")
            if token:
                diagnostic = diagnostic.replace(token, "[redacted]")
            print(diagnostic, file=sys.stderr)
            raise


def observe(dll, instance, fresh, seed_media=False):
    server = run_host(dll, instance, fresh=fresh, seed_media=seed_media)
    dbfile = instance/"data/data/jellyfin.db"
    assert dbfile.is_file(), dbfile
    fingerprint_js = """import {DatabaseSync} from 'node:sqlite'; import {inspectSqliteSchema} from './src/database/sqlite-schema.js'; const db = new DatabaseSync(process.argv[1], {readOnly:true}); try { console.log(inspectSqliteSchema(db).fingerprint); } finally { db.close(); }"""
    fingerprint = subprocess.check_output(["node","--input-type=module","-e",fingerprint_js,str(dbfile)],text=True).strip()
    with sqlite3.connect(dbfile.as_uri()+"?mode=ro", uri=True) as db:
        integrity = db.execute("PRAGMA integrity_check").fetchall()
        fk = db.execute("PRAGMA foreign_key_check").fetchall()
        assert integrity == [("ok",)] and not fk, (integrity, fk)
        history = dict(db.execute('SELECT MigrationId, ProductVersion FROM "__EFMigrationsHistory" ORDER BY MigrationId'))
        indexes = dict(db.execute("SELECT name, sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name"))
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        columns = {table:[list(row[1:]) for row in db.execute('PRAGMA table_xinfo("' + table.replace('"','""') + '")')] for table in tables}
        return {**server, "history":history, "indexes":indexes, "fingerprint":fingerprint, "tables":tables, "columns":columns, "integrity":"ok"}


@contextmanager
def emby_host(package, instance, port, initialize=False):
    if initialize:
        (instance/"config").mkdir(parents=True)
        (instance/"config/system.xml").write_text(f"<ServerConfiguration><HttpServerPortNumber>{port}</HttpServerPortNumber><PublicPort>{port}</PublicPort><EnableUPnP>false</EnableUPnP><EnableRemoteAccess>false</EnableRemoteAccess></ServerConfiguration>")
    args=["dotnet",str(package/"package/system/EmbyServer.dll"),"-programdata",str(instance),"-noautorunwebapp","-ffmpeg",os.environ["MEDIAMANAGER_FFMPEG"],"-ffprobe",os.environ["MEDIAMANAGER_FFPROBE"]]
    proc=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    token=""
    def call(route,method="GET",body=None):
        auth='Emby Client="Native exchange", Device="CI", DeviceId="native-exchange", Version="1"'
        if token: auth+=f', Token="{token}"'
        req=urllib.request.Request(f"http://127.0.0.1:{port}/emby"+route,method=method,
          data=None if body is None else json.dumps(body).encode(),headers={"Authorization":auth,"Content-Type":"application/json"})
        with urllib.request.urlopen(req,timeout=10) as response:
            data=response.read()
            return json.loads(data) if data else None
    try:
        for _ in range(320):
            if proc.poll() is not None: raise RuntimeError("Emby exited before readiness")
            try:
                info=call("/System/Info/Public")
                if info["Version"]==json.loads((package/"receipts/reference-input.json").read_text())["version"]: break
            except (OSError,ValueError): pass
            time.sleep(.25)
        else: raise RuntimeError("Official Emby was not ready")
        if initialize: call("/Startup/User","POST",{"Name":"bridge","Password":password})
        session=call("/Users/AuthenticateByName","POST",{"Username":"bridge","Pw":password})
        token=session["AccessToken"]
        if initialize: call("/Startup/Complete","POST")
        yield call,session["User"]["Id"]
        call("/System/Shutdown","POST")
        assert proc.wait(30)==0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(10)


def exchange_servers(native_dll,manager,schema,user,item,channel,package):
    work=runroot/("cross-"+channel)
    work.mkdir()
    template=work/"template"
    target=work/"emby"
    returned=work/"manager"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1",0))
        port=listener.getsockname()[1]
    with emby_host(package,template,port,initialize=True) as (_,account):
        mapping=work/"identities.json"
        mapping.write_text(json.dumps({"users":{user:account}}))
    def exchange(command,source,destination,db_schema,extra=()):
        argv=["node","tools/database/emby.js",command,"--source",str(source),"--output",str(destination),
              "--schema",db_schema,"--postgres-url-env","MEDIAMANAGER_TEST_POSTGRES",*map(str,extra)]
        result=json.loads(subprocess.check_output(argv,text=True))
        assert result["conflicts"]==0,json.loads(Path(result["report"]).read_text())["issues"]
    exchange("export",manager,target,schema,["--template",template,"--identity-map",mapping])
    with emby_host(package,target,port) as (call,account):
        tracks=call(f"/Users/{account}/Items?Recursive=true&IncludeItemTypes=Audio")["Items"]
        track=next(t for t in tracks if t["Name"]=="PG edited native audio")
        assert track["UserData"]["IsFavorite"]
        call(f'/Users/{account}/FavoriteItems/{track["Id"]}',"DELETE")
    after_schema="migration_cross_"+channel
    exchange("import",target,returned,after_schema)
    db=returned/"data/data/jellyfin.db"
    output_db=work/"postgres-return.db"
    subprocess.run(["node","tools/database/export-jellyfin.js","--output",str(output_db),"--schema",after_schema,"--postgres-url-env","MEDIAMANAGER_TEST_POSTGRES"],stdout=subprocess.DEVNULL,check=True)
    for suffix in ("-shm","-wal","-journal"): Path(str(db)+suffix).unlink(missing_ok=True)
    output_db.replace(db)
    result=run_host(native_dll,returned,fresh=False,edit_item=item,expected_favorite=False)
    assert result["userId"]==user
    return json.loads((package/"receipts/reference-input.json").read_text())["version"]


old, new = sys.argv[1:]
lineage = runroot/"history-upgrade"
samples = {}
for label, dll, instance, fresh in (("old",old,lineage,True),("newFresh",new,runroot/"history-fresh",True),("upgraded",new,lineage,False)):
    samples[label] = observe(dll,instance,fresh,seed_media=label=="newFresh")
    restored = runroot / ("restored-" + label)
    shutil.copytree(instance, restored)
    result_file = runroot / (label + "-export.db")
    binding = runroot / (label + "-binding.json")
    binding.write_text(json.dumps({"serverId":samples[label]["serverId"], "originIdentityDigest":"2"*64}))
    mounts = runroot / "mounts.json"
    mounts.write_text(json.dumps({"mounts":[{"mountId":"hosted-fixture","identityRoot":str(runroot),
        "accessRoot":"/media/hosted-fixture","pathStyle":"posix","caseSensitive":True,"returnPolicy":"required"}]}))
    pg = ["--postgres-url-env", "MEDIAMANAGER_TEST_POSTGRES", "--schema", "migration_" + label.lower()]
    src = instance / "data/data/jellyfin.db"
    imported = json.loads(subprocess.check_output(["node", "tools/database/import-jellyfin.js", "--source", str(src), "--instance-binding", str(binding), "--mount-contract", str(mounts), *pg], text=True))
    media_id = samples[label]["mediaId"]
    pg_probe = """import {PostgresDatabase} from './src/database/postgres.js'; import {nativeGuid} from './src/users/native.js';
const [schema,id,operation,user]=process.argv.slice(1); const db=await PostgresDatabase.open({schema,connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES});
try{const key={Id:nativeGuid(id)}; if(operation==='edit') await db.update('BaseItems',key,{Name:'PG edited native audio',IsLocked:true});
else {if((await db.rows('BaseItems',{where:key}))[0]?.Name!=='PG edited native audio' || !(await db.rows('UserData',{where:{ItemId:key.Id,UserId:nativeGuid(user)}})).some(r=>r.IsFavorite)) throw new Error('Native continuation was not imported');}}finally{await db.close();}"""
    if media_id:
        subprocess.run(["node","--input-type=module","-e",pg_probe,pg[-1],media_id,"edit"],check=True)
    exported = json.loads(subprocess.check_output(["node", "tools/database/export-jellyfin.js", "--output", str(result_file), *pg], text=True))
    assert imported["verified"] and exported["verified"]
    assert imported["migrationHistoryRows"] == exported["migrationHistoryRows"] == len(samples[label]["history"])
    with sqlite3.connect(result_file) as db:
        assert dict(db.execute('SELECT MigrationId, ProductVersion FROM "__EFMigrationsHistory"')) == samples[label]["history"]
    restored_db = restored / "data/data/jellyfin.db"
    for suffix in ("-shm","-wal","-journal"):
        Path(str(restored_db)+suffix).unlink(missing_ok=True)
    shutil.copyfile(result_file, restored_db)
    returned = run_host(dll, restored, fresh=False,edit_item=media_id)
    assert returned["serverId"] == samples[label]["serverId"]
    samples[label]["postgresRoundtrip"] = {"canonicalFingerprint":imported["nativeSchemaFingerprint"], "nativeColdStart":True}
    if media_id:
        again = pg[:-1]+["migration_continued"]
        subprocess.run(["node","tools/database/import-jellyfin.js","--source",str(restored_db),"--instance-binding",str(binding),"--mount-contract",str(mounts),*again],stdout=subprocess.DEVNULL,check=True)
        subprocess.run(["node","--input-type=module","-e",pg_probe,again[-1],media_id,"check",returned["userId"]],check=True)
        samples[label]["postgresRoundtrip"]["nativeAndPostgresEdits"]=True
        samples[label]["nativeToNative"]=[
            exchange_servers(new,restored,again[-1],returned["userId"],media_id,channel,Path(os.environ[var]))
            for channel,var in (("fixed","MEDIAMANAGER_EMBY_ALTERNATE_ROOT"),("rolling","MEDIAMANAGER_EMBY_REFERENCE_ROOT"))
        ]
    output.write_text(json.dumps(samples, indent=2)+"\n")
oldrows, newrows, upgrade = (set(samples[key]["history"]) for key in ("old","newFresh","upgraded"))
assert samples["old"]["serverId"] == samples["upgraded"]["serverId"]
assert newrows <= upgrade and oldrows <= upgrade, (newrows-upgrade, oldrows-upgrade)
assert samples["newFresh"]["tables"] == samples["upgraded"]["tables"]
assert samples["newFresh"]["columns"] == samples["upgraded"]["columns"]
assert samples["newFresh"]["indexes"] == samples["upgraded"]["indexes"]
print(json.dumps({"histories":[len(oldrows),len(newrows),len(upgrade)], "extraAfterUpgrade":sorted(upgrade-newrows), "freshOnlyVsOld":sorted(newrows-oldrows)}))
