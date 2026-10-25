using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using BlurHashSharp;
using BlurHashSharp.SkiaSharp;
using SkiaSharp;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var output = Path.GetFullPath(args[1]);
Directory.CreateDirectory(output);
var nativeName = OperatingSystem.IsWindows() ? "libSkiaSharp.dll" : OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so";
var nativePath = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeLibrary = NativeLibrary.Load(nativePath);
NativeLibrary.SetDllImportResolver(typeof(SKBitmap).Assembly, (name, assembly, searchPath) => name == "libSkiaSharp" ? nativeLibrary : IntPtr.Zero);
var results = new List<object>();
foreach (var sample in input.RootElement.GetProperty("images").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var filename = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, sample.GetProperty("filename").GetString()!));
    var bytes = File.ReadAllBytes(filename);
    using var codec = SKCodec.Create(filename);
    var original = codec.Info;
    var scale = ScaleHelper.GetScale(original.Width, original.Height, 128, 128);
    var supported = codec.GetScaledDimensions(scale);
    var info = new SKImageInfo { Width = supported.Width, Height = supported.Height, ColorType = SKColorType.Rgba8888,
        AlphaType = SKAlphaType.Unpremul, ColorSpace = SKColorSpace.CreateSrgb() };
    using var bitmap = SKBitmap.Decode(codec, info);
    var (sw, sh) = ScaleHelper.GetScaleDimensions(bitmap.Width, bitmap.Height, scale);
    using var resized = bitmap.Resize(info.WithSize(sw, sh), SKSamplingOptions.Default);
    var decoded = Rgba(bitmap);
    var scaled = Rgba(resized);
    var decodedPath = Path.Combine(output, name + ".decoded.rgba");
    var scaledPath = Path.Combine(output, name + ".scaled.rgba");
    File.WriteAllBytes(decodedPath, decoded);
    File.WriteAllBytes(scaledPath, scaled);
    float xf = MathF.Sqrt(16f * original.Width / original.Height), yf = xf * original.Height / original.Width;
    int xc = Math.Min((int)xf + 1, 9), yc = Math.Min((int)yf + 1, 9);
    using var stream = File.OpenRead(filename);
    var direct = BlurHashEncoder.Encode(xc, yc, stream, 128, 128);
    var core = CoreBlurHashEncoder.Encode(xc, yc, resized.Width, resized.Height, scaled, resized.Width * 4, PixelFormat.RGB888x);
    results.Add(new { name, inputSha256 = Hash(bytes), original = new { original.Width, original.Height },
        supported = new { supported.Width, supported.Height }, scale,
        decoded = new { bitmap.Width, bitmap.Height, bitmap.RowBytes, path = decodedPath, bytes = decoded.Length, sha256 = Hash(decoded) },
        scaled = new { resized.Width, resized.Height, resized.RowBytes, path = scaledPath, bytes = scaled.Length, sha256 = Hash(scaled) },
        components = new { xc, yc }, direct, core });
}
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualExecution = true, inputSha256 = Hash(inputBytes), results,
    nativeLibrary = new { filename = nativePath, sha256 = Hash(File.ReadAllBytes(nativePath)) },
    assemblies = new[] { typeof(SKBitmap).Assembly, typeof(BlurHashEncoder).Assembly, typeof(CoreBlurHashEncoder).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location))
    })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static byte[] Rgba(SKBitmap bitmap) {
    var output = new byte[bitmap.Width * bitmap.Height * 4];
    var pixels = bitmap.GetPixelSpan();
    for (var row = 0; row < bitmap.Height; row++) pixels.Slice(row * bitmap.RowBytes, bitmap.Width * 4).CopyTo(output.AsSpan(row * bitmap.Width * 4));
    return output;
}
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
