using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.LiveTv.Listings;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var root = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "cache-inputs"); Directory.CreateDirectory(root);
var origin = input.GetProperty("origin").GetString()!;
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z-]+$")) throw new InvalidOperationException("Unsafe sample name.");
    var cachePath = Path.Combine(root, name); var filename = Path.Combine(cachePath, "sd-countries.json");
    var observations = new List<object>(); var requests = new List<object>(); var clients = new List<HttpClient>(); var index = 0;
    var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
    HttpClient OpenClient(string clientName) {
        var value = new HttpClient(new RouteHandler(origin, () => (name, index), (url, named) => requests.Add(new { url, clientName = named }), clientName));
        if (value.Timeout.TotalMilliseconds != 100000) throw new InvalidOperationException("The default HttpClient deadline changed.");
        clients.Add(value); return value;
    }
    var factory = Stub.Make<IHttpClientFactory>((method, values) => method.Name == "CreateClient" ? OpenClient((string)values![0]!) : Stub.Default(method.ReturnType));
    SchedulesDirect? client = null;
    foreach (var action in sample.GetProperty("actions").EnumerateArray()) {
        if (action.TryGetProperty("removeDirectory", out var removeDirectory) && removeDirectory.GetBoolean() && Directory.Exists(filename)) Directory.Delete(filename);
        if (action.TryGetProperty("removeParentFile", out var removeParent) && removeParent.GetBoolean() && File.Exists(cachePath)) File.Delete(cachePath);
        if (action.TryGetProperty("parentFile", out var parentFile) && parentFile.GetBoolean()) { Directory.CreateDirectory(Path.GetDirectoryName(cachePath)!); File.WriteAllText(cachePath, "controlled blocker"); }
        if (action.TryGetProperty("cacheDirectory", out var directory) && directory.GetBoolean()) Directory.CreateDirectory(filename);
        if (action.TryGetProperty("cacheBase64", out var cache)) {
            Directory.CreateDirectory(cachePath); File.WriteAllBytes(filename, Convert.FromBase64String(cache.GetString()!));
            File.SetLastWriteTimeUtc(filename, DateTime.UtcNow.AddDays(action.TryGetProperty("ageDays", out var age) ? -age.GetDouble() : 0));
        }
        if (action.TryGetProperty("deleteCache", out var delete) && delete.GetBoolean()) File.Delete(filename);
        if (client is null || action.TryGetProperty("restart", out var restart) && restart.GetBoolean()) { client?.Dispose(); client = new SchedulesDirect(NullLogger<SchedulesDirect>.Instance, factory, paths); }
        string? error = null, value = null; bool? writable = null;
        try {
            await using var stream = await client.GetAvailableCountries(CancellationToken.None);
            writable = stream.CanWrite; using var result = new MemoryStream(); await stream.CopyToAsync(result); value = Convert.ToBase64String(result.ToArray());
        } catch (Exception caught) { error = caught.GetType().Name; }
        observations.Add(new { index, error, value, writable, disk = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null,
            diskDirectory = Directory.Exists(filename), parentFile = File.Exists(cachePath), requests = requests.Count });
        index++;
    }
    client?.Dispose(); foreach (var http in clients) http.Dispose(); results.Add(new { name, observations, requests });
}
var limits = new List<object>(); var today = DateTime.UtcNow.Date;
foreach (var kind in new[] { "absent", "today", "future", "past", "invalid", "invariant", "utf16", "offset" }) {
    var cachePath = Path.Combine(root, "limit-" + kind); Directory.CreateDirectory(cachePath);
    var filename = Path.Combine(cachePath, "sd-image-limit.txt");
    var text = kind switch { "today" => today.ToString("O"), "future" => today.AddDays(1).ToString("O"), "past" => today.AddDays(-1).ToString("O"),
        "invariant" => today.ToString("MMMM d, yyyy", CultureInfo.InvariantCulture), "utf16" => today.ToString("O"),
        "offset" => new DateTimeOffset(today, TimeSpan.Zero).ToOffset(TimeSpan.FromHours(14)).ToString("O"), _ => "not a date" };
    if (kind != "absent") File.WriteAllText(filename, text, kind == "utf16" ? Encoding.Unicode : new UTF8Encoding(false));
    var fileBefore = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
    var factory = Stub.Make<IHttpClientFactory>((method, _) => throw new InvalidOperationException("Daily limit reads must not open HTTP clients."));
    using var client = new SchedulesDirect(NullLogger<SchedulesDirect>.Instance, factory, paths);
    var first = client.IsImageDailyLimitActive(); var afterInitialize = File.Exists(filename);
    File.WriteAllText(filename, today.AddDays(-2).ToString("O"));
    var second = client.IsImageDailyLimitActive();
    limits.Add(new { kind, text, fileBefore, first, second, afterInitialize, afterOverwrite = File.Exists(filename) });
}
var tryDeleteMethod = typeof(SchedulesDirect).GetMethod("TryDeleteFile", BindingFlags.NonPublic | BindingFlags.Static)!;
var directoryPath = Path.Combine(root, "delete-directory"); Directory.CreateDirectory(directoryPath); string? deleteError = null;
try { tryDeleteMethod.Invoke(null, [directoryPath]); } catch (TargetInvocationException caught) { deleteError = caught.InnerException!.GetType().Name; }
var assembly = typeof(SchedulesDirect).Assembly;
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualSchedulesDirect = true, actualGetAvailableCountries = true, actualLoadDailyLimitDate = true,
    actualTryDeleteFile = true, controlledLoopbackUriRouting = true, actualPhysicalCache = true, databaseOwnersOpened = false, executorsStarted = false,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), today = today.ToString("yyyy-MM-dd"), deleteDirectoryError = deleteError, defaultHttpClientTimeoutMs = 100000,
    assembly = new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }, results, limits }));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class RouteHandler(string origin, Func<(string Name, int Index)> action, Action<string, string> report, string clientName) : HttpClientHandler {
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        report(request.RequestUri!.AbsoluteUri, clientName);
        if (request.Method != HttpMethod.Get || request.RequestUri.AbsoluteUri != "https://json.schedulesdirect.org/20141201/available/countries") throw new InvalidOperationException("Unexpected countries request.");
        var current = action(); request.RequestUri = new Uri(origin + "/countries?name=" + current.Name + "&index=" + current.Index);
        return base.SendAsync(request, token);
    }
}
