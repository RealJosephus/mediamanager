using System.Runtime.InteropServices;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using BlurHashSharp;
using BlurHashSharp.SkiaSharp;
using Emby.Server.Implementations.IO;
using Jellyfin.Drawing;
using Jellyfin.Drawing.Skia;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var declaration = input.RootElement;
var inputRoot = Path.GetDirectoryName(Path.GetFullPath(args[0]))!;
var output = Path.GetFullPath(args[1]);
Directory.CreateDirectory(output);
var nativeName = OperatingSystem.IsWindows() ? "libSkiaSharp.dll" : OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so";
var nativePath = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeLibrary = NativeLibrary.Load(nativePath);
NativeLibrary.SetDllImportResolver(typeof(SKBitmap).Assembly, (name, assembly, searchPath) => name == "libSkiaSharp" ? nativeLibrary : IntPtr.Zero);
var paths = Proxy.Make<IServerApplicationPaths>((method, values) => method.Name switch {
    "get_ProgramDataPath" or "get_DataPath" => output,
    "get_CachePath" or "get_ImageCachePath" => Path.Combine(output, "cache"),
    "get_TempDirectory" => Path.Combine(output, "temp"),
    _ => throw new NotSupportedException("Unexpected application path: " + method.Name)
});
var configuration = new ServerConfiguration { ParallelImageEncodingLimit = 1 };
var config = Proxy.Make<IServerConfigurationManager>((method, values) => method.Name switch {
    "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
    _ => throw new NotSupportedException("Unexpected configuration access: " + method.Name)
});
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
using var processor = new ImageProcessor(NullLogger<ImageProcessor>.Instance, paths, fileSystem,
    new SkiaEncoder(NullLogger<SkiaEncoder>.Instance, paths), config);
var results = new List<object>();
foreach (var sample in declaration.GetProperty("images").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var filename = Path.GetFullPath(Path.Combine(inputRoot, sample.GetProperty("filename").GetString()!));
    var sourceBytes = File.ReadAllBytes(filename);
    int width = 0, height = 0;
    object? headerError = null;
    try {
        using var codec = SKCodec.Create(filename);
        if (codec == null) throw new InvalidDataException("The native codec did not accept the source header.");
        width = codec.Info.Width; height = codec.Info.Height;
    } catch (Exception exception) { headerError = Failure(exception); }
    var original = processor.GetImageDimensions(filename);
    int hashWidth = original.Width, hashHeight = original.Height;
    if (sample.TryGetProperty("hashDimensions", out var supplied)) {
        hashWidth = supplied.GetProperty("Width").GetInt32(); hashHeight = supplied.GetProperty("Height").GetInt32();
    }
    float xf = MathF.Sqrt(16f * hashWidth / hashHeight), yf = xf * hashHeight / hashWidth;
    int xc = Math.Min((int)xf + 1, 9), yc = Math.Min((int)yf + 1, 9);
    var requests = new List<(string name, float scale)> { ("full", 1), ("max128", ScaleHelper.GetScale(hashWidth, hashHeight, 128, 128)) };
    if (sample.TryGetProperty("thresholds", out var thresholds) && thresholds.GetBoolean())
        requests.AddRange(declaration.GetProperty("thresholdScales").EnumerateArray().Select(row =>
            (row.GetProperty("name").GetString()!, row.GetProperty("value").GetSingle())));
    var decoded = new List<object>();
    foreach (var request in requests) {
        object? error = null;
        byte[]? pixels = null;
        string? pixelPath = null, core = null;
        int decodedWidth = 0, decodedHeight = 0, supportedWidth = 0, supportedHeight = 0;
        try {
            using var codec = SKCodec.Create(filename);
            if (codec == null) throw new InvalidDataException("The native codec did not accept the source header.");
            var supported = codec.GetScaledDimensions(request.scale);
            supportedWidth = supported.Width; supportedHeight = supported.Height;
            using var color = SKColorSpace.CreateSrgb();
            var info = new SKImageInfo(supported.Width, supported.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul, color);
            using var bitmap = SKBitmap.Decode(codec, info);
            if (bitmap == null) throw new InvalidDataException("The native bitmap decoder did not return pixels.");
            decodedWidth = bitmap.Width; decodedHeight = bitmap.Height;
            pixels = Rgba(bitmap);
            pixelPath = Path.Combine(output, name + "." + request.name + ".rgba");
            File.WriteAllBytes(pixelPath, pixels);
            core = CoreBlurHashEncoder.Encode(xc, yc, bitmap.Width, bitmap.Height, pixels, bitmap.Width * 4, PixelFormat.RGB888x);
        } catch (Exception exception) { error = Failure(exception); }
        decoded.Add(new { name = request.name, request.scale, supported = new { Width = supportedWidth, Height = supportedHeight },
            Width = decodedWidth, Height = decodedHeight, pixelPath, bytes = pixels?.Length, sha256 = pixels == null ? null : Hash(pixels), core, error });
    }
    var hashRequests = new List<(string name, ImageDimensions dimensions)> { ("original", new ImageDimensions(hashWidth, hashHeight)) };
    if (sample.TryGetProperty("thresholds", out var cachedDimensions) && cachedDimensions.GetBoolean())
        hashRequests.AddRange(declaration.GetProperty("cachedDimensions").EnumerateArray().Select(row => (row.GetProperty("name").GetString()!,
            new ImageDimensions(row.GetProperty("Width").GetInt32(), row.GetProperty("Height").GetInt32()))));
    var hashes = new List<object>();
    string? direct = null;
    object? directError = null;
    foreach (var request in hashRequests) {
        object? error = null;
        string? value = null;
        try { value = processor.GetImageBlurHash(filename, request.dimensions); }
        catch (Exception exception) { error = Failure(exception); }
        if (request.name == "original") { direct = value; directError = error; }
        hashes.Add(new { name = request.name, dimensions = new { request.dimensions.Width, request.dimensions.Height }, value, error });
    }
    bool unlocked = true;
    try { using var exclusive = File.Open(filename, FileMode.Open, FileAccess.Read, FileShare.None); }
    catch { unlocked = false; }
    results.Add(new { name, filename, inputSha256 = Hash(sourceBytes), sourceUnchanged = sourceBytes.SequenceEqual(File.ReadAllBytes(filename)),
        sourceUnlocked = unlocked, headerError, original = new { original.Width, original.Height }, codecOriginal = new { Width = width, Height = height },
        hashDimensions = new { Width = hashWidth, Height = hashHeight }, components = new { xc, yc }, decoded, direct, directError, hashes });
}
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualSkiaJpegCodec = true, actualBlurHashSharp = true, actualImageProcessor = true, inputSha256 = Hash(inputBytes), results,
    nativeLibrary = new { filename = nativePath, sha256 = Hash(File.ReadAllBytes(nativePath)) },
    assemblies = new[] { typeof(SKBitmap).Assembly, typeof(BlurHashEncoder).Assembly, typeof(CoreBlurHashEncoder).Assembly,
        typeof(ImageProcessor).Assembly, typeof(SkiaEncoder).Assembly, typeof(ManagedFileSystem).Assembly,
        typeof(IServerApplicationPaths).Assembly, typeof(ServerConfiguration).Assembly }.Distinct()
        .Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static object Failure(Exception exception) => new { type = exception.GetType().FullName, exception.Message, exception.HResult };
static byte[] Rgba(SKBitmap bitmap) {
    var output = new byte[bitmap.Width * bitmap.Height * 4];
    var source = bitmap.GetPixelSpan();
    for (int y = 0; y < bitmap.Height; y++) source.Slice(y * bitmap.RowBytes, bitmap.Width * 4).CopyTo(output.AsSpan(y * bitmap.Width * 4));
    return output;
}

public class Proxy : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Proxy>(); ((Proxy)(object)value).Handler = handler; return value;
    }
}
