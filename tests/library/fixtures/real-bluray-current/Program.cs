using System.Globalization;
using BDInfo;
using MediaBrowser.MediaEncoding.BdInfo;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Server;
using Jellyfin.Server.Extensions;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.IO;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

if (args.Length != 4) throw new ArgumentException("Usage: Oracle <input.json> <disc-root> <ffmpeg> <output-root>");
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]);
using var document = JsonDocument.Parse(inputBytes);
var input = document.RootElement;
var disc = Path.GetFullPath(args[1]);
var root = Path.GetFullPath(args[3]);
var sourceFiles = Directory.GetFiles(disc, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).Select(filename => {
    using var file = File.OpenRead(filename);
    return new { path = Path.GetRelativePath(disc, filename).Replace('\\', '/'), bytes = file.Length,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(file)) };
}).OrderBy(file => file.path, StringComparer.Ordinal).ToArray();
var expected = input.GetProperty("files").EnumerateArray().OrderBy(file => file.GetProperty("path").GetString(), StringComparer.Ordinal).ToArray();
if (sourceFiles.Length != expected.Length) throw new InvalidOperationException("The Native source must retain every complete original BDMV file.");
for (var index = 0; index < expected.Length; index++) {
    var file = sourceFiles[index]; var original = expected[index];
    if (file.path != original.GetProperty("path").GetString() || file.bytes != original.GetProperty("bytes").GetInt64()
        || file.sha256 != original.GetProperty("sha256").GetString()) throw new InvalidOperationException("A complete original Blu-ray source member changed.");
}
var paths = new ServerApplicationPaths(Path.Combine(root, "state"), Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
var serializer = new MyXmlSerializer();
serializer.SerializeToFile(new ServerConfiguration { UICulture = "en-US" }, Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
serializer.SerializeToFile(new EncodingOptions { EncoderAppPath = args[2], EncodingThreadCount = 2 }, Path.Combine(paths.ConfigurationDirectoryPath, "encoding.xml"));
var manager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer);
manager.RegisterConfiguration<EncodingConfigurationFactory>();
var configuration = new ConfigurationBuilder().AddInMemoryCollection(new StartupOptions { FFmpegPath = args[2] }.ConvertToConfig()).Build();
var files = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var localization = new LocalizationManager(manager, NullLogger<LocalizationManager>.Instance);
var examiner = new BdInfoExaminer(files);
using var encoder = new MediaEncoder(NullLogger<MediaEncoder>.Instance, manager, files, examiner, localization, configuration, manager);
if (!encoder.SetFFmpegPath()) throw new InvalidOperationException("The actual Native media encoder rejected the supplied executable.");
if (Path.GetFullPath(encoder.ProbePath) != Path.GetFullPath(input.GetProperty("ffprobe").GetString()!))
    throw new InvalidOperationException("Native must use the same pinned ffprobe input.");
string Relative(string filename) => Path.GetRelativePath(disc, filename).Replace('\\', '/');
var actualDiscInfo = examiner.GetDiscInfo(disc);
var bdrom = new BDROM(BdInfoDirectoryInfo.FromFileSystemPath(files, disc));
bdrom.Scan();
var selected = bdrom.PlaylistFiles.Values.OrderByDescending(value => value.TotalLength).FirstOrDefault(value => value.IsValid)
    ?? throw new InvalidOperationException("The complete original Blu-ray must expose a valid actual playlist.");
var selections = new[] { new { files = encoder.GetPrimaryPlaylistM2tsFiles(disc).Select(Relative).ToArray() } };
var plan = new { playlistName = selected.Name, runTimeTicks = actualDiscInfo.RunTimeTicks, chapters = selected.Chapters,
    files = selected.StreamClips.Where(clip => clip.AngleIndex == 0).Select(clip => new {
        virtualPath = Relative(clip.StreamFile.FileInfo.FullName), timeIn = clip.TimeIn, timeOut = clip.TimeOut,
        relativeTimeIn = clip.RelativeTimeIn }) };
// FetchBdInfo constructs these actual model values from the selected chapters.
// Retain the complete constructor result, including its DateTime default.
var chapterDefaults = actualDiscInfo.Chapters.Select(seconds => new MediaBrowser.Model.Entities.ChapterInfo {
    StartPositionTicks = TimeSpan.FromSeconds(seconds).Ticks }).ToArray();
var probes = new List<object>();
long? totalTicks = 0;
var targets = Directory.GetFiles(disc, "*", SearchOption.AllDirectories).ToDictionary(
    filename => Uri.UnescapeDataString(new Uri(LocalMediaProxy.GetProxyUrl(filename)).AbsolutePath), StringComparer.Ordinal);
var requests = new ConcurrentQueue<object>();
var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:5244");
var app = builder.Build();
app.MapMethods("/d/{**path}", ["GET", "HEAD"], (HttpContext context) => {
    if (!targets.TryGetValue(context.Request.Path.Value!, out var filename)) return Results.NotFound();
    requests.Enqueue(new { context.Request.Method, path = context.Request.Path.Value, file = Relative(filename), range = context.Request.Headers.Range.ToString() });
    return Results.File(filename, "application/octet-stream", enableRangeProcessing: true);
});
await app.StartAsync();
try {
    foreach (var filename in encoder.GetPrimaryPlaylistM2tsFiles(disc)) {
        var information = await encoder.GetMediaInfo(new MediaInfoRequest { MediaType = DlnaProfileType.Video, ExtractChapters = true,
            MediaSource = new MediaSourceInfo { Path = filename, Protocol = MediaProtocol.File } }, CancellationToken.None);
        totalTicks += information.RunTimeTicks;
        probes.Add(new { file = Relative(filename), information });
    }
    if (probes.Count == 0) throw new InvalidOperationException("The complete original Blu-ray must select and probe its original M2TS.");
} finally {
    await app.StopAsync(); await app.DisposeAsync();
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.Location, StringComparer.Ordinal).Select(assembly => new { name = assembly.GetName().Name,
        filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
File.WriteAllText(Path.Combine(root, "native.json"), JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualManagedFileSystem = true,
    actualMediaEncoder = true, actualFfprobe = true, actualNativeBdInfo = true,
    actualDiscInfo, plan, chapterDefaults, encoder.EncoderPath, encoder.ProbePath,
    sourceFiles, selections, probes, totalTicks, assemblies, proxy = new { requests, closed = true,
        controlled = "Actual source fork LocalMediaProxy served from the complete verified original files." },
    actualScan = false, actualDatabaseExchange = false, phaseAcceptance = false
}, new JsonSerializerOptions { WriteIndented = true, Converters = { new JsonStringEnumConverter() } }) + "\n");
