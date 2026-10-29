using System.Diagnostics;
using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;

if (args.Length != 3) throw new ArgumentException("Usage: Oracle bound-input.json NEW_CASE_ROOT NEW_NATIVE_JSON");
var inputPath = Path.GetFullPath(args[0]);
var caseRoot = Path.GetFullPath(args[1]);
var output = Path.GetFullPath(args[2]);
if (File.Exists(output) || Directory.Exists(output)) throw new IOException("Native output must be new.");
var inputBytes = File.ReadAllBytes(inputPath);
var input = JsonSerializer.Deserialize<BoundInput>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var specification = input.Specification;
if (specification.Tables.Length != 33 || specification.NfoChangeWaitMs != 60001 || specification.NfoChangeToleranceMs != 60000)
    throw new IOException("Unexpected complete Movie scenario contract.");
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(specification.Culture);
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(specification.Culture);
foreach (var file in new[] { input.Database, input.Media })
{
    if (!Path.IsPathFullyQualified(file.Filename)) throw new IOException("Bound inputs require explicit absolute paths.");
    var bytes = File.ReadAllBytes(file.Filename);
    if (bytes.LongLength != file.Bytes || Hash(bytes) != file.Sha256) throw new IOException("Bound input changed: " + file.Filename);
}
var startedAt = DateTime.UtcNow;
var timeZone = new { id = TimeZoneInfo.Local.Id, offsetMinutes = (int)TimeZoneInfo.Local.GetUtcOffset(startedAt).TotalMinutes };
if (timeZone.offsetMinutes != specification.LocalTimezoneOffsetMinutes) throw new IOException("The actual local timezone differs from the neutral input.");
var observations = new List<object>();
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
var sqliteResolutions = new ConcurrentQueue<string>();
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
{
    if (name != "e_sqlite3") return IntPtr.Zero;
    sqliteResolutions.Enqueue(name);
    return sqliteHandle;
});
object? registration = null, updateInput = null;
NativeScanHost? host = null;
Exception? failure = null;
try
{
    var options = new LibraryOptions
    {
        SaveLocalMetadata = true, MetadataSavers = ["Nfo"], AutomaticallyAddToCollection = true,
        PathInfos = [new MediaPathInfo { Path = Path.Combine(caseRoot, "media") }],
        EnableRealtimeMonitor = false, EnableChapterImageExtraction = false, EnableTrickplayImageExtraction = false,
        EnableInternetProviders = false,
        TypeOptions = new[] { "Movie", "BoxSet", "Genre", "MusicGenre", "Studio", "Folder", "CollectionFolder" }
            .Select(type => new TypeOptions { Type = type, MetadataFetchers = [], ImageFetchers = [] }).ToArray()
    };
    host = await NativeScanHost.CreateAsync(caseRoot, new Scenario
    {
        Name = specification.Name, Fanout = 1,
        Libraries = [new LibrarySeed { Name = "Movies", Locations = [""], CollectionType = "movies", SaveLocalMetadata = true, Options = options }]
    }, input.Database.Filename, MovieProviders.CreateImageProcessor);
    registration = MovieProviders.Install(host, input.Ffmpeg);
    foreach (var name in specification.Movies)
    {
        var target = host.MediaPath(name + ".mkv");
        File.Copy(input.Media.Filename, target);
        var attributesBefore = File.GetAttributes(target);
        File.SetAttributes(target, attributesBefore & ~FileAttributes.ReadOnly);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(target, File.GetUnixFileMode(target) | UnixFileMode.UserWrite);
        var copiedBytes = File.ReadAllBytes(target);
        if (copiedBytes.LongLength != input.Media.Bytes || Hash(copiedBytes) != input.Media.Sha256)
            throw new IOException("The writable business media clone changed the frozen input bytes.");
        host.Add("controlled-media-copy", new { filename = target, attributesBefore, attributesAfter = File.GetAttributes(target),
            bytes = copiedBytes.LongLength, sha256 = Hash(copiedBytes), protectedSource = input.Media.Filename });
        File.WriteAllText(host.MediaPath(name + ".nfo"), Nfo(name, specification.OriginalGenre, false), new UTF8Encoding(false));
    }
    host.Add("input-files-ready", new { at = DateTime.UtcNow, files = Files(host) });
    await Scan("created");
    var first = Movies(host).Single(item => item.Path == host.MediaPath("First.mkv"));
    var firstId = first.Id;
    var saved = first.DateLastSaved;
    if (saved == DateTime.MinValue) throw new IOException("The actual initial Movie NFO saver did not establish DateLastSaved.");
    while (DateTime.UtcNow <= saved.AddMilliseconds(specification.NfoChangeWaitMs))
        await Task.Delay(20);
    var beforeWrite = DateTime.UtcNow;
    File.WriteAllText(host.MediaPath("First.nfo"), Nfo("Updated First", specification.ChangedGenre, true), new UTF8Encoding(false));
    var observedModified = File.GetLastWriteTimeUtc(host.MediaPath("First.nfo"));
    var elapsed = observedModified - saved;
    updateInput = new { originalItemId = firstId, saved, beforeWrite, observedModified, elapsedTicks = elapsed.Ticks,
        toleranceTicks = TimeSpan.FromMilliseconds(specification.NfoChangeToleranceMs).Ticks,
        text = File.ReadAllText(host.MediaPath("First.nfo")) };
    if (elapsed <= TimeSpan.FromMilliseconds(specification.NfoChangeToleranceMs))
        throw new IOException("The actual NFO mtime did not exceed the original one-minute tolerance.");
    await Scan("updated");
    if (Movies(host).Single(item => item.Path == host.MediaPath("First.mkv")).Id != firstId)
        throw new IOException("The NFO update changed the Movie identity.");
    File.Delete(host.MediaPath("First.mkv")); File.Delete(host.MediaPath("First.nfo"));
    await Scan("deleted");
}
catch (Exception error) { failure = error; }
finally
{
    if (host is not null)
    {
        try { host.SetPhase("cleanup"); await host.DisposeAsync(); }
        catch (Exception error) { failure = failure is null ? error : new AggregateException(failure, error); }
    }
    foreach (var file in new[] { input.Database, input.Media })
        if (Hash(File.ReadAllBytes(file.Filename)) != file.Sha256)
            failure = new IOException("The frozen common input changed: " + file.Filename, failure);
    var record = new
    {
        schemaVersion = 1, actualExecution = true, inputSha256 = Hash(inputBytes), input.Database, input.Media,
        root = caseRoot, startedAt, endedAt = DateTime.UtcNow, timeZone, registration, observations, updateInput,
        input.ClockWindowStart,
        process = new { pid = Environment.ProcessId, startedAt = Process.GetCurrentProcess().StartTime.ToUniversalTime(),
            entryAssembly = typeof(BoundInput).Assembly.Location },
        trace = host?.Trace, releasedResources = host?.ReleasedResources,
        initialCloneSha256 = host?.InitialCloneSha256,
        fullSchemaCloned = true, schemaCreated = false, preparationExecutedAsBusiness = false,
        protectedInputsUnchanged = Hash(File.ReadAllBytes(input.Database.Filename)) == input.Database.Sha256
            && Hash(File.ReadAllBytes(input.Media.Filename)) == input.Media.Sha256,
        failure = failure?.ToString(), releaseAcceptance = false,
        assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
            .Select(assembly => new { assembly.FullName, filename = assembly.Location, bytes = new FileInfo(assembly.Location).Length,
                sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray(),
        nativeModules = sqliteResolutions.IsEmpty ? [] : new[] { new { ModuleName = sqliteName, filename = sqliteFilename,
            bytes = new FileInfo(sqliteFilename).Length, sha256 = Hash(File.ReadAllBytes(sqliteFilename)),
            loadedBy = "NativeLibrary.Load", resolvedBy = "SetDllImportResolver", importName = "e_sqlite3",
            providerAssembly = typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly.Location,
            handle = sqliteHandle.ToInt64(), export = NativeLibrary.GetExport(sqliteHandle, "sqlite3_libversion").ToInt64(),
            resolverRequests = sqliteResolutions.Count, resolvedNames = sqliteResolutions.ToArray() } }
    };
    using var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
    JsonSerializer.Serialize(stream, record, new JsonSerializerOptions { WriteIndented = true });
}
if (failure is not null) throw failure;
Console.WriteLine(JsonSerializer.Serialize(new { output, scans = 3, observations = observations.Count }));

async Task Scan(string phase)
{
    host!.SetPhase(phase);
    var before = DateTime.UtcNow;
    var scan = await host.RunAsync();
    observations.Add(new { phase, boundary = "global-returned", startedAt = before, endedAt = DateTime.UtcNow,
        status = scan.Exception is null ? "completed" : "failed", scanRunning = scan.ScanRunning,
        scan.Exception, scan.ExceptionMessage, queue = host.QueueState(), snapshot = Snapshot(host, includeSidecars: false) });
    await host.DrainMetadataQueueAsync();
    if (phase == "created" && scan.Exception is null)
    {
        if (specification.ExplicitMovieSaveUpdateReason != (int)ItemUpdateType.MetadataEdit)
            throw new IOException("The neutral explicit Movie save must use MetadataEdit.");
        foreach (var movieName in specification.Movies)
        {
            var item = Movies(host).Single(value => value.Path == host.MediaPath(movieName + ".mkv"));
            host.Add("explicit-movie-save-begin", new { item = host.Item(item), updateReason = specification.ExplicitMovieSaveUpdateReason });
            await host.Manager.UpdateItemAsync(item, item.GetParent(), ItemUpdateType.MetadataEdit, CancellationToken.None);
            host.Add("explicit-movie-save-completed", new { item = host.Item(item), updateReason = specification.ExplicitMovieSaveUpdateReason });
        }
    }
    observations.Add(new { phase, boundary = "metadata-drained", startedAt = before, endedAt = DateTime.UtcNow,
        status = scan.Exception is null ? "completed" : "failed", scanRunning = host.Manager.IsScanRunning,
        scan.Exception, scan.ExceptionMessage, queue = host.QueueState(), snapshot = Snapshot(host) });
    if (scan.Exception is not null) throw new IOException(scan.ExceptionMessage);
}
string Nfo(string title, string genre, bool locked) => "<movie><title>" + title + "</title><plot>" + specification.Overview
    + "</plot>" + (locked ? "<lockdata>true</lockdata>" : "") + "<set><name>" + specification.CollectionName
    + "</name></set><genre>" + genre + "</genre><studio>" + specification.Studio
    + "</studio><custom keep=\"true\">retained</custom></movie>";
static Movie[] Movies(NativeScanHost value) => value.Manager.GetItemList(new InternalItemsQuery
    { IncludeItemTypes = [BaseItemKind.Movie], Recursive = true }).OfType<Movie>().ToArray();
object Snapshot(NativeScanHost value, bool includeSidecars = true)
{
    var sql = JsonSerializer.SerializeToElement(value.SnapshotSql());
    var actual = sql.GetProperty("tables").EnumerateArray().Select(entry => entry.GetString()!).ToArray();
    if (!actual.SequenceEqual(specification.Tables.Order(StringComparer.Ordinal))) throw new IOException("The native snapshot lost a schema table.");
    using var db = value.Factory.CreateDbContext(); db.Database.OpenConnection();
    using var command = db.Database.GetDbConnection().CreateCommand();
    command.CommandText = "SELECT name, seq FROM sqlite_sequence ORDER BY name";
    using var reader = command.ExecuteReader(); var sequence = new List<object>();
    while (reader.Read()) sequence.Add(new { name = reader.GetString(0), seq = reader.GetInt64(1) });
    var mediaFiles = Directory.EnumerateFiles(value.MediaRoot, "*.mkv", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
        .Select(filename => new { path = Path.GetRelativePath(value.CaseRoot, filename).Replace('\\', '/'),
            bytes = new FileInfo(filename).Length, sha256 = Hash(File.ReadAllBytes(filename)) }).ToArray();
    return new { sql = sql.GetProperty("result"), tables = actual, sqliteSequence = sequence,
        files = includeSidecars ? Files(value) : null, mediaFiles };
}
static object[] Files(NativeScanHost value) => Directory.EnumerateFiles(value.CaseRoot, "*", SearchOption.AllDirectories)
    .Where(filename => filename.EndsWith(".nfo", StringComparison.OrdinalIgnoreCase)
        || filename.EndsWith("collection.xml", StringComparison.OrdinalIgnoreCase))
    .Order(StringComparer.Ordinal).Select(filename =>
    {
        var relative = Path.GetRelativePath(value.CaseRoot, filename).Replace('\\', '/');
        var bytes = File.ReadAllBytes(filename);
        return (object)new { path = relative, filename, bytes = bytes.Length, sha256 = Hash(bytes),
            text = Encoding.UTF8.GetString(bytes), lastWriteTimeUtc = File.GetLastWriteTimeUtc(filename) };
    }).ToArray();
static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

public sealed class BoundInput
{
    public Specification Specification { get; set; } = new();
    public FileBinding Database { get; set; } = new();
    public FileBinding Media { get; set; } = new();
    public string Ffmpeg { get; set; } = "";
    public string ClockWindowStart { get; set; } = "";
}
public sealed class FileBinding
{
    public string Filename { get; set; } = "";
    public long Bytes { get; set; }
    public string Sha256 { get; set; } = "";
}
public sealed class Specification
{
    public int LocalTimezoneOffsetMinutes { get; set; }
    public string Name { get; set; } = "";
    public string Culture { get; set; } = "en-US";
    public string[] Movies { get; set; } = [];
    public string[] Tables { get; set; } = [];
    public string Overview { get; set; } = "";
    public string CollectionName { get; set; } = "";
    public string OriginalGenre { get; set; } = "";
    public string ChangedGenre { get; set; } = "";
    public string Studio { get; set; } = "";
    public int NfoChangeToleranceMs { get; set; }
    public int NfoChangeWaitMs { get; set; }
    public int ExplicitMovieSaveUpdateReason { get; set; }
}
