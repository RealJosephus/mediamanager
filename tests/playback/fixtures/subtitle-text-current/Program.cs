using System.Reflection;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Api.Middleware;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Hosting;
using Nikse.SubtitleEdit.Core.SubtitleFormats;

var inputBytes = await File.ReadAllBytesAsync(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var output = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
var files = Path.Combine(output, "inputs"); Directory.CreateDirectory(files);
var utf8 = new UTF8Encoding(false);
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
object Error(Exception error) => new { name = error.GetType().Name, error.Message, error.StackTrace };
var sourceManager = DispatchProxy.Create<IMediaSourceManager, SourceBoundary>();
var boundary = (SourceBoundary)sourceManager;
var parser = new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance);
using var clients = new TextClients();
using var encoder = new SubtitleEncoder(NullLogger<SubtitleEncoder>.Instance, null!, null!, clients, sourceManager, parser, null!, null!);
var sourceByName = input.GetProperty("sources").EnumerateArray().ToDictionary(sample => sample.GetProperty("name").GetString()!);
var descriptors = new List<object>();
foreach (var (name, sample) in sourceByName)
{
    var path = Path.Combine(files, name + "." + sample.GetProperty("format").GetString());
    var bytes = sample.TryGetProperty("base64", out var payload) ? Convert.FromBase64String(payload.GetString()!)
        : utf8.GetBytes(sample.GetProperty("text").GetString()!);
    await File.WriteAllBytesAsync(path, bytes);
    descriptors.Add(new { name, filename = path, bytes = bytes.Length, sha256 = Hash(bytes) });
}
var sourceRequests = new ConcurrentQueue<object>();
var completedRequests = new ConcurrentQueue<string>();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
builder.WebHost.UseUrls("http://127.0.0.1:0"); builder.Logging.ClearProviders();
await using var app = builder.Build();
app.MapGet("/{name}", async (HttpContext context, string name) =>
{
    var source = sourceByName.Values.FirstOrDefault(source => source.GetProperty("name").GetString() + "." + source.GetProperty("format").GetString() == name);
    if (source.ValueKind == JsonValueKind.Undefined) { context.Response.StatusCode = 404; return; }
    var bytes = await File.ReadAllBytesAsync(Path.Combine(files, name), context.RequestAborted);
    sourceRequests.Enqueue(new { requestId = context.TraceIdentifier, path = context.Request.Path.Value, context.Request.Method, bytes = bytes.Length, sha256 = Hash(bytes) });
    context.Response.OnCompleted(() => { completedRequests.Enqueue(context.TraceIdentifier); return Task.CompletedTask; });
    context.Response.ContentType = MimeTypes.GetMimeType(name); context.Response.ContentLength = bytes.Length;
    await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
});
await app.StartAsync();
var inputOrigin = app.Urls.Single();
async Task<object> PublicFailure(Exception error, string format)
{
    var context = new DefaultHttpContext(); context.Request.Method = "GET";
    context.Request.Path = "/Videos/f8600000000000000000000000000001/f8600000000000000000000000000001/Subtitles/0/Stream." + format;
    using var body = new MemoryStream(); context.Response.Body = body;
    var middleware = new ExceptionMiddleware(_ => Task.FromException(error), NullLogger<ExceptionMiddleware>.Instance, null!, app.Environment);
    await middleware.Invoke(context);
    var bytes = body.ToArray();
    return new { status = context.Response.StatusCode, contentType = context.Response.ContentType,
        bytes = Convert.ToBase64String(bytes), sha256 = Hash(bytes), text = utf8.GetString(bytes) };
}
var item = new Video { Id = Guid.Parse("f8600000-0000-0000-0000-000000000001") };
void Select(JsonElement sample)
{
    var name = sample.GetProperty("name").GetString()!;
    var format = sample.GetProperty("format").GetString()!;
    var path = inputOrigin + "/" + name + "." + format;
    boundary.Source = new MediaSourceInfo { Id = item.Id.ToString("N"), Path = path, Protocol = MediaProtocol.Http,
        MediaStreams = new List<MediaStream> { new() { Index = 0, Type = MediaStreamType.Subtitle,
            Codec = format, Path = path, IsExternal = true, SupportsExternalStream = true } } };
}
string Read(string text, string format)
{
    if (format == "ttml")
    {
        // Explicit writer-body consumer; the generic extension registry remains unchanged.
        var document = new Nikse.SubtitleEdit.Core.Common.Subtitle();
        using var reader = new StringReader(text);
        var lines = new List<string>();
        for (var line = reader.ReadLine(); line != null; line = reader.ReadLine()) lines.Add(line);
        new TimedText10().LoadSubtitle(document, lines, "writer.ttml");
        return new JsonWriter().ToText(document, "untitled");
    }
    using var bytes = new MemoryStream(utf8.GetBytes(text));
    return new JsonWriter().ToText(parser.Parse(bytes, format), "untitled");
}
var conversions = new List<object>();
foreach (var sample in input.GetProperty("conversions").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var source = sourceByName[sample.GetProperty("source").GetString()!];
    Select(source);
    try
    {
        await using var stream = await ((ISubtitleEncoder)encoder).GetSubtitles(item, boundary.Source!.Id, 0,
            sample.GetProperty("format").GetString()!, long.Parse(sample.GetProperty("start").GetString()!),
            long.Parse(sample.GetProperty("end").GetString()!), sample.GetProperty("copy").GetBoolean(), CancellationToken.None);
        using var collected = new MemoryStream(); await stream.CopyToAsync(collected);
        var bytes = collected.ToArray(); var text = utf8.GetString(bytes);
        var format = sample.GetProperty("format").GetString()!;
        string? readerJson = null; object? readerError = null;
        if (format != "json")
        {
            try { readerJson = Read(text, format); }
            catch (Exception error) { readerError = Error(error); }
        }
        conversions.Add(new { name, bytes = Convert.ToBase64String(bytes), sha256 = Hash(bytes), text,
            contentType = MimeTypes.GetMimeType("file." + format), readerJson, readerError, error = (object?)null });
    }
    catch (Exception error) { conversions.Add(new { name, error = Error(error), wire = await PublicFailure(error, sample.GetProperty("format").GetString()!) }); }
}
var originals = new List<object>();
foreach (var (name, source) in sourceByName)
{
    Select(source);
    var sourceFormat = source.GetProperty("format").GetString()!;
    foreach (var format in sourceFormat == "ssa" ? new[] { "ssa", "ass" } : new[] { sourceFormat })
    {
        try
        {
            await using var stream = await ((ISubtitleEncoder)encoder).GetSubtitles(item, boundary.Source!.Id, 0, format, 0, 0, true, CancellationToken.None);
            using var collected = new MemoryStream(); await stream.CopyToAsync(collected);
            var bytes = collected.ToArray();
            originals.Add(new { name, format, bytes = Convert.ToBase64String(bytes), sha256 = Hash(bytes), error = (object?)null });
        }
        catch (Exception error) { originals.Add(new { name, format, error = Error(error), wire = await PublicFailure(error, format) }); }
    }
}
var candidateReaders = new List<object>();
foreach (var sample in input.GetProperty("candidate").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var generation = sample.GetProperty("generation").GetInt32();
    var format = sample.GetProperty("format").GetString()!;
    if (sample.GetProperty("status").GetInt32() >= 400)
    {
        candidateReaders.Add(new { name, generation, textConsumerApplicable = false, status = sample.GetProperty("status").GetInt32() });
        continue;
    }
    try
    {
        var text = utf8.GetString(Convert.FromBase64String(sample.GetProperty("bytes").GetString()!));
        candidateReaders.Add(new { name, generation, readerJson = format == "json" ? JsonDocument.Parse(text).RootElement.GetRawText() : Read(text, format), error = (object?)null });
    }
    catch (Exception error) { candidateReaders.Add(new { name, generation, error = Error(error) }); }
}
var sourceAfter = sourceByName.Select(pair => new { name = pair.Key,
    sha256 = Hash(File.ReadAllBytes(Path.Combine(files, pair.Key + "." + pair.Value.GetProperty("format").GetString()))) }).ToArray();
var assemblies = new[] { typeof(SubtitleEncoder).Assembly, typeof(Nikse.SubtitleEdit.Core.SubtitleFormats.SubtitleFormat).Assembly, typeof(UtfUnknown.CharsetDetector).Assembly,
    typeof(MediaSourceInfo).Assembly, typeof(ExceptionMiddleware).Assembly }.Distinct().Select(assembly => new { name = assembly.GetName().Name,
        filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
clients.Dispose(); await app.StopAsync();
var inputHostClosed = app.Lifetime.ApplicationStopped.IsCancellationRequested;
await File.WriteAllTextAsync(args[1], JsonSerializer.Serialize(new { schemaVersion = 1, actualExecution = true, pid = Environment.ProcessId,
    inputSha256 = Hash(inputBytes), sources = descriptors, sourceAfter, conversions, originals, candidateReaders, assemblies,
    sourceRequests = sourceRequests.ToArray(), completedRequests = completedRequests.ToArray(), inputHostClosed, inputClientsClosed = clients.Closed,
    errorEnvironment = app.Environment.EnvironmentName },
    new JsonSerializerOptions { WriteIndented = true }), utf8);

public class SourceBoundary : DispatchProxy
{
    public MediaSourceInfo? Source { get; set; }
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => method?.Name switch
    {
        "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>(new[] { Source! }),
        "GetPathProtocol" => MediaProtocol.Http,
        _ => throw new NotSupportedException("The text fixture does not supply " + method?.Name)
    };
}

public sealed class TextClients : IHttpClientFactory, IDisposable
{
    private readonly HttpClient _client = new();
    public bool Closed { get; private set; }
    public HttpClient CreateClient(string name) => _client;
    public void Dispose() { _client.Dispose(); Closed = true; }
}
