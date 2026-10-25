using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Branding;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Branding;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Net;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var root = Path.GetFullPath(args[0]);
var inputBytes = File.ReadAllBytes(args[1]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var capture = new Capture(root);
capture.Reset(JsonSerializer.SerializeToElement(new { name = "host" }));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders();
builder.Services.AddSingleton(capture);
builder.Services.AddSingleton<IServerConfigurationManager>(_ => capture.Configuration);
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => {
    options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").RequireAuthenticatedUser().Build();
    options.AddPolicy(Policies.RequiresElevation, new AuthorizationPolicyBuilder("fixture").RequireRole(UserRoles.Administrator).Build());
});
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyControllers()));
builder.Services.Replace(ServiceDescriptor.Transient<BrandingController>(_ => new BrandingController(capture.Configuration)));
builder.Services.Replace(ServiceDescriptor.Transient<ConfigurationController>(_ => new ConfigurationController(capture.Configuration, Stub.Make<IMediaEncoder>())));
builder.Services.Replace(ServiceDescriptor.Transient<ImageController>(_ => new ImageController(
    Stub.Make<IUserManager>(), Stub.Make<ILibraryManager>(), Stub.Make<IProviderManager>(), capture.Processor,
    new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, capture.Paths, []), NullLogger<ImageController>.Instance,
    capture.Configuration, capture.Paths)));
var app = builder.Build();
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
using var client = new HttpClient();
var results = new List<object>();
try {
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Reset(sample);
        using var request = new HttpRequestMessage(new HttpMethod(Capture.Text(sample, "method") ?? "GET"), address + Capture.Text(sample, "path"));
        request.Headers.TryAddWithoutValidation("Accept", Capture.Text(sample, "accept") ?? "application/json");
        if (sample.TryGetProperty("headers", out var headers)) foreach (var header in headers.EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
        if (sample.TryGetProperty("body", out var body)) request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body.GetString()!));
        if (Capture.Text(sample, "contentType") is { } contentType) {
            request.Content ??= new ByteArrayContent([]); request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        }
        using var response = await client.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        object? jsonBody = null; try { jsonBody = JsonSerializer.Deserialize<JsonElement>(bytes); } catch (JsonException) { }
        var selectedHeaders = new[] { "Content-Type", "Content-Length", "ETag", "Cache-Control", "Pragma", "Last-Modified", "Vary", "Content-Disposition", "transferMode.dlna.org", "realTimeInfo.dlna.org" };
        var responseHeaders = selectedHeaders.Select(name => new { name = name.ToLowerInvariant(),
            values = response.Headers.TryGetValues(name, out var values) ? values : response.Content.Headers.TryGetValues(name, out values) ? values : null })
            .Where(entry => entry.values is not null).ToDictionary(entry => entry.name, entry => string.Join(", ", entry.values!));
        var options = (BrandingOptions)capture.Configuration.GetConfiguration("branding");
        BrandingOptions? disk = null;
        try { disk = (BrandingOptions?)new MyXmlSerializer().DeserializeFromFile(typeof(BrandingOptions), capture.ConfigFile); } catch { }
        var files = Directory.Exists(capture.Paths.DataPath) ? Directory.GetFiles(capture.Paths.DataPath).Order().Select(filename => new {
            name = Path.GetFileName(filename), bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }).ToArray() : [];
        results.Add(new { name = Capture.Text(sample, "name"), status = (int)response.StatusCode, headers = responseHeaders,
            body = Convert.ToBase64String(bytes), jsonBody, live = options, disk, calls = capture.Calls.ToArray(), files });
        capture.ReleaseReadOnly();
    }
} finally { await app.StopAsync(); await app.DisposeAsync(); }
var mimeTypes = (Dictionary<string, string>)typeof(MediaBrowser.Model.MimeTypes).GetField("s_typeMap", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
var imageMimes = mimeTypes.Values.Where(value => value.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
    .Concat(new[] { "image/jpeg", "image/jpg", "image/tiff", "image/x-png", "image/x-icon" }).Distinct().Order()
    .Select(value => new { mimeType = value, extension = MimeTypes.ToExtension(value) }).ToArray();
var mimeSamples = input.GetProperty("contentTypes").EnumerateArray().Select(value => {
    var text = value.ValueKind == JsonValueKind.Null ? null : value.GetString();
    var method = typeof(ImageController).GetMethod("TryGetImageExtensionFromContentType", BindingFlags.NonPublic | BindingFlags.Static)!;
    object?[] arguments = [text, null]; var accepted = (bool)method.Invoke(null, arguments)!;
    return new { contentType = text, accepted, extension = arguments[1] };
}).ToArray();
var transforms = new List<object>();
foreach (var sample in input.GetProperty("streams").EnumerateArray()) {
    using var source = new ChunkStream(sample.GetProperty("chunks").EnumerateArray().Select(value => Encoding.UTF8.GetBytes(value.GetString()!)).ToArray());
    using var output = new MemoryStream();
    string? failure = null;
    try {
        await using var decoder = new CryptoStream(source, new FromBase64Transform(), CryptoStreamMode.Read);
        await decoder.CopyToAsync(output);
    } catch (Exception error) { failure = error.GetType().Name; }
    transforms.Add(new { name = Capture.Text(sample, "name"), bytes = Convert.ToBase64String(output.ToArray()), failure });
}
var assemblyTypes = new[] { typeof(ImageController), typeof(BrandingOptions), typeof(ServerConfigurationManager), typeof(MyXmlSerializer) };
File.WriteAllText(args[2], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualControllers = true, actualNamedConfiguration = true, actualXmlSerializer = true,
    actualBase64Stream = true, realFiles = true, processorControlled = true, authenticationControlled = true,
    assemblies = assemblyTypes.Select(type => type.Assembly).Distinct().Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }),
    imageMimes, mimeSamples, transforms, results
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture(string root) {
    public JsonElement Sample;
    public ServerApplicationPaths Paths = null!;
    public ServerConfigurationManager Configuration = null!;
    public IImageProcessor Processor = null!;
    public List<object> Calls = new();
    public string ConfigFile => Path.Combine(Paths.ConfigurationDirectoryPath, "branding.xml");
    public static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var entry) ? entry.GetString() : null;
    public static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var entry) && entry.GetBoolean();
    public void Reset(JsonElement sample) {
        Sample = sample; Calls.Clear();
        var directory = Path.Combine(root, "cases", Text(sample, "name")!); Directory.CreateDirectory(directory);
        Paths = new ServerApplicationPaths(directory, Path.Combine(directory, "log"), Path.Combine(directory, "config"), Path.Combine(directory, "cache"), Path.Combine(directory, "web"));
        Directory.CreateDirectory(Paths.ConfigurationDirectoryPath); Directory.CreateDirectory(Paths.DataPath);
        var options = sample.TryGetProperty("initial", out var initial) ? JsonSerializer.Deserialize<BrandingOptions>(initial)! : new BrandingOptions();
        if (options.SplashscreenLocation is not null && options.SplashscreenLocation != " ") options.SplashscreenLocation = Path.Combine(Paths.DataPath, options.SplashscreenLocation);
        new MyXmlSerializer().SerializeToFile(options, ConfigFile);
        if (Text(sample, "xml") is { } xml) File.WriteAllText(ConfigFile, xml);
        var modified = new DateTime(2024, 6, 2, 12, 34, 56, DateTimeKind.Utc);
        if (sample.TryGetProperty("files", out var files)) foreach (var file in files.EnumerateObject()) {
            var filename = Path.Combine(Paths.DataPath, file.Name); File.WriteAllBytes(filename, Convert.FromBase64String(file.Value.GetString()!)); File.SetLastWriteTimeUtc(filename, modified);
        }
        if (Text(sample, "directoryFile") is { } directoryFile) Directory.CreateDirectory(Path.Combine(Paths.DataPath, directoryFile));
        Configuration = new ServerConfigurationManager(Paths, NullLoggerFactory.Instance, new MyXmlSerializer());
        Configuration.RegisterConfiguration<BrandingConfigurationFactory>();
        if (Flag(sample, "directoryConfig")) { File.Delete(ConfigFile); Directory.CreateDirectory(ConfigFile); }
        Configuration.NamedConfigurationUpdating += (_, args) => Calls.Add(new { phase = "configuration-updating", options = JsonSerializer.SerializeToElement(args.NewConfiguration) });
        Configuration.NamedConfigurationUpdated += (_, args) => Calls.Add(new { phase = "configuration-updated", options = JsonSerializer.SerializeToElement(args.NewConfiguration) });
        if (Flag(sample, "readOnlyConfig")) File.SetAttributes(ConfigFile, FileAttributes.ReadOnly);
        if (Text(sample, "readOnlyFile") is { } readOnlyFile) File.SetAttributes(Path.Combine(Paths.DataPath, readOnlyFile), FileAttributes.ReadOnly);
        if (Flag(sample, "missingData")) Directory.Delete(Paths.DataPath, true);
        Processor = Stub.Make<IImageProcessor>((method, arguments) => {
            if (method.Name != "ProcessImage") throw new NotSupportedException(method.Name);
            var value = (ImageProcessingOptions)arguments![0]!;
            Calls.Add(new { phase = "image", path = value.Image.Path, dateModified = value.Image.DateModified, value.Quality,
                value.Width, value.Height, value.MaxWidth, value.MaxHeight, value.FillWidth, value.FillHeight, value.Blur,
                value.BackgroundColor, value.ForegroundLayer, formats = value.SupportedOutputFormats.Select(format => format.ToString()).ToArray() });
            return Task.FromResult((value.Image.Path, (string?)"image/png", DateTime.MinValue));
        });
    }
    public void ReleaseReadOnly() {
        if (File.Exists(ConfigFile)) File.SetAttributes(ConfigFile, FileAttributes.Normal);
        if (Directory.Exists(Paths.DataPath)) foreach (var filename in Directory.GetFiles(Paths.DataPath)) File.SetAttributes(filename, FileAttributes.Normal);
    }
}
public class OnlyControllers : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var type in feature.Controllers.Where(type => !new[] { typeof(BrandingController), typeof(ConfigurationController), typeof(ImageController) }.Contains(type.AsType())).ToArray()) feature.Controllers.Remove(type);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Capture.Text(capture.Sample, "identity") ?? "anonymous";
        if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim>(); if (identity == "admin") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, "fixture")));
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = (method, _) => method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
    public static T Make<T>(Func<MethodInfo, object?[]?, object?>? handler = null) where T : class {
        var value = Create<T, Stub>(); if (handler is not null) ((Stub)(object)value).Handler = handler; return value;
    }
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
}
public class ChunkStream(byte[][] chunks) : Stream {
    private int index, offset;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int start, int count) {
        while (index < chunks.Length && chunks[index].Length == offset) { index++; offset = 0; }
        if (index == chunks.Length) return 0;
        count = Math.Min(count, chunks[index].Length - offset); Array.Copy(chunks[index], offset, buffer, start, count); offset += count; return count;
    }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
        var bytes = new byte[buffer.Length]; var count = Read(bytes, 0, bytes.Length); bytes.AsMemory(0, count).CopyTo(buffer); return ValueTask.FromResult(count);
    }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
