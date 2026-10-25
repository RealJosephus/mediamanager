using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Books.OpenPackagingFormat;
using Microsoft.Extensions.Logging;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
if (args.Length != 3) throw new ArgumentException("Expected input manifest, new assets directory and output JSON.");
var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var requestedTimeZone = input.RootElement.GetProperty("timeZone").GetString()!;
if (Environment.GetEnvironmentVariable("TZ") != requestedTimeZone)
    throw new IOException("The declared time zone input must be bound to the native process.");
var expectedOffsetMinutes = input.RootElement.GetProperty("timeZoneOffsetMinutes").GetInt32();
var timeZoneInstant = input.RootElement.GetProperty("timeZoneInstant").GetString()!;
var utc = DateTime.Parse(timeZoneInstant, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
var offsetMinutes = TimeZoneInfo.Local.GetUtcOffset(utc).TotalMinutes;
// Windows .NET uses the system time zone, independently of TZ. Verify its
// actual offset rather than treating the requested environment as evidence.
if (offsetMinutes != expectedOffsetMinutes) throw new IOException("The native host does not provide the declared time zone offset.");
var timeZoneControl = new { requested = requestedTimeZone, effective = TimeZoneInfo.Local.Id,
    instant = timeZoneInstant, offsetMinutes };
var assets = Path.GetFullPath(args[1]);
if (Directory.Exists(assets)) throw new IOException("The native case directory must be new.");
Directory.CreateDirectory(assets);
var source = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, "assets");
foreach (var entry in input.RootElement.GetProperty("assets").EnumerateArray())
{
    var relative = entry.GetProperty("path").GetString()!;
    if (Path.IsPathRooted(relative) || relative.Split('/').Contains("..")) throw new IOException("Invalid declared asset path.");
    var bytes = File.ReadAllBytes(Path.Combine(source, relative));
    if (Hash(bytes) != entry.GetProperty("sha256").GetString() || bytes.LongLength != entry.GetProperty("length").GetInt64())
        throw new IOException("The declared asset bytes changed: " + relative);
    var target = Path.Combine(assets, relative);
    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    File.WriteAllBytes(target, bytes);
}
Directory.CreateDirectory(Path.Combine(assets, "epub/directory.epub"));
var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_TempDirectory" ? Path.Combine(assets, "temp") : Stub.Default(method.ReturnType));
var fileSystem = new ManagedFileSystem(new CaptureLogger<ManagedFileSystem>(), paths, Array.Empty<IShortcutHandler>());
var results = new List<object>();
foreach (var sample in input.RootElement.GetProperty("epubs").EnumerateArray())
{
    var filename = Path.Combine(assets, sample.GetProperty("path").GetString()!);
    var token = sample.GetProperty("cancelled").GetBoolean() ? new CancellationToken(true) : CancellationToken.None;
    var metadataLogger = new CaptureLogger<EpubProvider>();
    var imageLogger = new CaptureLogger<EpubImageProvider>();
    object? result = null;
    string? error = null, coverError = null, coverSha = null, coverFormat = null;
    bool? hasCover = null;
    try { result = Project(await new EpubProvider(fileSystem, metadataLogger).GetMetadata(new ItemInfo(new Book { Path = filename }), null!, token)); }
    catch (Exception exception) { error = exception.GetType().Name; }
    try
    {
        var response = await new EpubImageProvider(imageLogger).GetImage(new Book { Path = filename }, ImageType.Primary, token);
        hasCover = response.HasImage;
        if (response.HasImage)
        {
            using var stream = response.Stream;
            using var bytes = new MemoryStream();
            await stream.CopyToAsync(bytes);
            coverSha = Hash(bytes.ToArray());
            coverFormat = response.Format.ToString();
        }
    }
    catch (Exception exception) { coverError = exception.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), result, error, hasCover, coverError, coverSha, coverFormat, metadataLogs = metadataLogger.Errors, imageLogs = imageLogger.Errors });
}
var assemblies = new[] { typeof(OpfProvider).Assembly, typeof(Book).Assembly, typeof(ManagedFileSystem).Assembly, Assembly.Load("jellyfin") }
    .Select(value => new { value.FullName, sha256 = Hash(File.ReadAllBytes(value.Location)) });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualExecution = true, results, timeZoneControl, assemblies,
    inputSha256 = Hash(inputBytes), platform = Environment.OSVersion.Platform.ToString(), localTimeZone = TimeZoneInfo.Local.Id }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static object Project(MetadataResult<Book> result) => new
{
    result.HasMetadata, result.ResultLanguage,
    item = result.Item == null ? null : new
    {
        result.Item.Name, result.Item.ForcedSortName, result.Item.Overview, result.Item.Studios,
        result.Item.ProviderIds, result.Item.Genres, result.Item.IndexNumber, result.Item.SeriesName,
        result.Item.ProductionYear, communityRatingDouble = (double?)result.Item.CommunityRating,
        premiereTicks = result.Item.PremiereDate?.Ticks.ToString()
    },
    people = result.People?.Select(person => new { person.Name, type = person.Type.ToString(), person.Role, person.ProviderIds })
};
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class CaptureLogger<T> : ILogger<T>
{
    public List<string> Errors = new();
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    { if (level >= LogLevel.Error) Errors.Add(exception?.GetType().Name ?? "no-exception"); }
}
