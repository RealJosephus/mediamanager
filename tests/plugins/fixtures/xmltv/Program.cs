using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Listings;
using Jellyfin.XmlTv;
using MediaBrowser.Common;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var options = JsonDefaults.Options;
var etagType = typeof(XmlTvListingsProvider).Assembly.GetType("Jellyfin.LiveTv.Listings.XmlTvProgramEtag", true)!;
var create = etagType.GetMethod("TryCreate", BindingFlags.NonPublic | BindingFlags.Static)!;
var etags = new List<object>();
foreach (var sample in input.GetProperty("etagCases").EnumerateArray())
{
    var program = sample.GetProperty("program").Deserialize<ProgramInfo>(options)!;
    object?[] arguments = [program, null, null];
    bool? created = null;
    string? error = null;
    try { created = (bool)create.Invoke(null, arguments)!; }
    catch (Exception caught) { error = (caught is TargetInvocationException wrapped ? wrapped.InnerException! : caught).GetType().Name; }
    etags.Add(new { name = sample.GetProperty("name").GetString(), program, created, etag = arguments[1], reason = arguments[2], error });
}
var xmlCases = new List<object>();
var cacheCases = new List<object>();
var dateCases = new List<object>();
if (input.TryGetProperty("dateCases", out var dateInputs)) foreach (var sample in dateInputs.EnumerateArray())
{
    var value = XmlTvReader.ParseDate(sample.GetString()!);
    dateCases.Add(new { input = sample.GetString(), value = value is null ? null : new {
        utc = value.Value.UtcDateTime.ToString("O"), offsetDate = value.Value.ToString("O") } });
}
var privateRoot = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "private-xmltv-inputs");
try
{
    if (input.TryGetProperty("xmlCases", out var sources)) foreach (var sample in sources.EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!;
        var directory = Path.Combine(privateRoot, name);
        Directory.CreateDirectory(directory);
        var filename = Path.Combine(directory, "source.xml");
        var encodedInput = sample.TryGetProperty("sourceBase64", out var sourceBase64);
        var xmlBytes = encodedInput ? Convert.FromBase64String(sourceBase64.GetString()!) : System.Text.Encoding.UTF8.GetBytes(sample.GetProperty("xml").GetString()!);
        File.WriteAllBytes(filename, xmlBytes);
        var info = sample.TryGetProperty("info", out var supplied) ? supplied.Deserialize<ListingsProviderInfo>(options)! : new ListingsProviderInfo();
        info.Id = name; info.Path = filename;
        var cachePath = Path.Combine(directory, "cache");
        var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
        var server = new ServerConfiguration { PreferredMetadataLanguage = sample.TryGetProperty("serverLanguage", out var configuredLanguage) ? configuredLanguage.GetString() : "en" };
        var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
        {
            "get_ApplicationPaths" => paths,
            "get_Configuration" => server,
            _ => Stub.Default(method.ReturnType)
        });
        var http = Stub.Make<IHttpClientFactory>((method, _) => method.Name == "CreateClient" ? new HttpClient() : Stub.Default(method.ReturnType));
        var provider = new XmlTvListingsProvider(config, http, NullLogger<XmlTvListingsProvider>.Instance);
        var start = DateTime.Parse(sample.GetProperty("start").GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind);
        var end = DateTime.Parse(sample.GetProperty("end").GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind);
        var observations = new List<object>();
        foreach (var operation in new[] { "readerChannels", "channels", "programs", "lineups" })
        {
            if (encodedInput && operation == "readerChannels") continue;
            object? value = null;
            string? error = null;
            try
            {
                if (operation == "readerChannels") value = new XmlTvReader(filename,
                    string.IsNullOrWhiteSpace(info.PreferredLanguage) ? server.PreferredMetadataLanguage : info.PreferredLanguage).GetChannels()
                    .Select(channel => new { channel.Id, channel.DisplayName, channel.Number, iconsNull = channel.Icons is null,
                        icons = channel.Icons?.Select(icon => icon.Source).ToArray() }).ToArray();
                else if (operation == "channels") value = await provider.GetChannels(info, CancellationToken.None);
                else if (operation == "lineups") value = await provider.GetLineups(info, "US", "ignored");
                else value = (await provider.GetProgramsAsync(info, sample.GetProperty("channelId").GetString()!, start, end, CancellationToken.None)).ToArray();
            }
            catch (Exception caught) { error = caught.GetType().Name; }
            observations.Add(new { operation, value, error });
        }
        var cacheFile = Path.Combine(cachePath, "xmltv", name + ".xml");
        var cached = File.Exists(cacheFile) ? File.ReadAllBytes(cacheFile) : null;
        xmlCases.Add(new { name, sourceSha256 = Convert.ToHexString(SHA256.HashData(xmlBytes)).ToLowerInvariant(), observations,
            cachedSha256 = cached is null ? null : Convert.ToHexString(SHA256.HashData(cached)).ToLowerInvariant(),
            cacheFiles = Directory.Exists(cachePath) ? Directory.GetFiles(cachePath, "*", SearchOption.AllDirectories).Select(file => Path.GetRelativePath(cachePath, file).Replace('\\', '/')).Order().ToArray() : [] });
    }
    if (input.TryGetProperty("cacheCases", out var cacheSources)) foreach (var sample in cacheSources.EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!;
        var cachePath = Path.Combine(privateRoot, "cache-" + name);
        var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
        var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
        {
            "get_ApplicationPaths" => paths,
            "get_Configuration" => new ServerConfiguration(),
            _ => Stub.Default(method.ReturnType)
        });
        var mode = string.Empty;
        using var handler = new ControlledHandler(() => mode);
        using var control = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var http = Stub.Make<IHttpClientFactory>((method, _) => method.Name == "CreateClient" ? new HttpClient(handler, false) : Stub.Default(method.ReturnType));
        var provider = new XmlTvListingsProvider(config, http, NullLogger<XmlTvListingsProvider>.Instance);
        var info = new ListingsProviderInfo { Id = name, Path = sample.GetProperty("path").GetString()! };
        var cacheFile = Path.Combine(cachePath, "xmltv", name + ".xml");
        var observations = new List<object>();
        var index = 0;
        foreach (var action in sample.GetProperty("actions").EnumerateArray())
        {
            mode = action.GetProperty("mode").GetString()!;
            await control.GetStringAsync(input.GetProperty("controlOrigin").GetString() + "/control?engine=native&name=" + Uri.EscapeDataString(name) + "&index=" + index);
            if (action.TryGetProperty("ageCache", out var ageCache) && ageCache.GetBoolean() && File.Exists(cacheFile)) File.SetLastWriteTimeUtc(cacheFile, DateTime.UtcNow.AddHours(-2));
            if (action.TryGetProperty("clearCache", out var clearCache) && clearCache.GetBoolean()) File.Delete(cacheFile);
            object? value = null;
            string? failure = null;
            var operation = action.TryGetProperty("operation", out var requestedOperation) ? requestedOperation.GetString() : "lineups";
            using var cancellation = new CancellationTokenSource();
            try
            {
                if (operation == "validate") await provider.Validate(info, true, true);
                else if (operation == "programs")
                {
                    var pending = provider.GetProgramsAsync(info, "c1", new DateTime(2026, 10, 21, 0, 0, 0, DateTimeKind.Utc),
                        new DateTime(2026, 10, 22, 0, 0, 0, DateTimeKind.Utc), cancellation.Token);
                    if (action.TryGetProperty("cancelAfterBody", out var cancelAfterBody) && cancelAfterBody.GetBoolean())
                    {
                        try { await control.GetStringAsync(input.GetProperty("controlOrigin").GetString() + "/wait-body?engine=native&name=" + Uri.EscapeDataString(name) + "&index=" + index); }
                        catch { cancellation.Cancel(); try { await pending; } catch { } throw; }
                        cancellation.Cancel();
                    }
                    value = (await pending).ToArray();
                }
                else value = await provider.GetLineups(info, "US", "ignored");
            }
            catch (Exception caught) { failure = cancellation.IsCancellationRequested && caught is OperationCanceledException ? "canceled"
                : caught is TimeoutException ? "timeout" : caught.GetType().Name; }
            var cached = File.Exists(cacheFile) ? File.ReadAllBytes(cacheFile) : null;
            observations.Add(new { index, operation, value, failure, cacheExists = cached is not null,
                cacheSha256 = cached is null ? null : Convert.ToHexString(SHA256.HashData(cached)).ToLowerInvariant(),
                cacheFiles = Directory.Exists(cachePath) ? Directory.GetFiles(cachePath, "*", SearchOption.AllDirectories).Select(file => Path.GetRelativePath(cachePath, file).Replace('\\', '/')).Order().ToArray() : [] });
            index++;
        }
        cacheCases.Add(new { name, observations });
    }
}
finally { if (Directory.Exists(privateRoot)) Directory.Delete(privateRoot, true); }
var assemblies = new[] { typeof(XmlTvListingsProvider).Assembly, typeof(XmlTvReader).Assembly, typeof(ProgramInfo).Assembly, typeof(JsonDefaults).Assembly }
    .Distinct().Select(assembly => new { name = assembly.GetName().Name, version = assembly.GetName().Version!.ToString(),
        informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualXmlTvProgramEtag = true, actualXmlTvReaderAssembly = true, readerPackageVersion = "10.12.0-pre1",
    readerSourceCommit = "6c8c302c8520e5f41cd51dd392ac631f97179d82", etags, dateCases, xmlCases, cacheCases,
    nativeTimeoutExceptionControlled = true, privateInputsRemoved = !Directory.Exists(privateRoot), assemblies }, options));

public class ControlledHandler : DelegatingHandler
{
    private readonly Func<string> _mode;
    public ControlledHandler(Func<string> mode) : base(new HttpClientHandler()) { _mode = mode; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => _mode() == "timeout" ? Task.FromException<HttpResponseMessage>(new TaskCanceledException("Controlled HttpClient timeout.", new TimeoutException()))
            : base.SendAsync(request, cancellationToken);
}

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
