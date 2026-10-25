using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Providers.Books;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SharpCompress.Archives;
using SharpCompress.Readers;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var declaration = input.RootElement;
var inputRoot = Path.GetDirectoryName(Path.GetFullPath(args[0]))!;
var output = Path.GetFullPath(args[1]);
Directory.CreateDirectory(output);
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(Text(declaration, "culture"));
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, values) =>
    method.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(method.ReturnType));
var assetBindings = new List<object>();
var directoryCases = new List<object>();
var selectedCases = new List<object>();
var edgeCases = new List<object>();
var cryptoCases = new List<object>();
string Asset(string key) => Path.GetFullPath(Path.Combine(inputRoot, Text(declaration.GetProperty("assets"), key)));
foreach (var asset in declaration.GetProperty("assets").EnumerateObject()) {
    var filename = Asset(asset.Name);
    var bytes = File.ReadAllBytes(filename);
    assetBindings.Add(new { name = asset.Name, path = filename, bytes = bytes.Length, sha256 = Hash(bytes) });
}
foreach (var sample in declaration.GetProperty("directoryCases").EnumerateArray()) {
    var name = Text(sample, "name");
    var root = Path.Combine(output, name);
    Directory.CreateDirectory(root);
    var filename = Path.Combine(root, "book.cbr");
    if (Text(sample, "format") == "asset") File.Copy(Asset(Text(sample, "asset")), filename);
    else WriteStoredArchive(filename, sample);
    directoryCases.Add(new { name, path = filename, sourceSha256 = Hash(File.ReadAllBytes(filename)),
        catalog = await Catalog(filename, root), cover = await Cover(filename, root), sourceUnlocked = Unlocked(filename) });
}
foreach (var category in new[] { "selectedCases", "edgeCases" }) {
    foreach (var sample in declaration.GetProperty(category).EnumerateArray()) {
        var name = Text(sample, "name");
        var root = Path.Combine(output, name);
        Directory.CreateDirectory(root);
        var filename = Path.Combine(root, "book.cbr");
        var bytes = File.ReadAllBytes(Asset(Text(sample, "asset")));
        var mutation = Text(sample, "mutation");
        File.WriteAllBytes(filename, mutation.Length == 0 ? bytes : Mutate(bytes, mutation));
        if (category == "selectedCases") selectedCases.Add(new { name, path = filename,
            sourceSha256 = Hash(File.ReadAllBytes(filename)), catalog = await Catalog(filename, root),
            cover = await Cover(filename, root), sourceUnlocked = Unlocked(filename) });
        else {
            var explicitPassword = Text(sample, "mode") == "explicit";
            object observation;
            if (explicitPassword) observation = await ReadOrdinal(filename, 1, root, Text(sample, "password"));
            else observation = await Cover(filename, root, Text(sample, "cancel"));
            edgeCases.Add(new { name, path = filename, sourceSha256 = Hash(File.ReadAllBytes(filename)),
                explicitPassword, observation, sourceUnlocked = Unlocked(filename) });
        }
    }
}
var noSalt = Path.Combine(output, "no-salt-native-default", "book.cbr");
foreach (var sample in declaration.GetProperty("cryptoCases").EnumerateArray()) {
    var name = Text(sample, "name");
    var ordinal = sample.GetProperty("ordinal").GetInt32();
    var root = Path.Combine(output, name);
    Directory.CreateDirectory(root);
    object? error = null;
    byte[] bytes = [];
    string? key = null, salt = null, streamType = null;
    long compressedSize = 0;
    using (var source = File.OpenRead(noSalt))
    using (var archive = ArchiveFactory.OpenArchive(source)) {
        var entry = archive.Entries.ElementAt(ordinal);
        key = entry.Key;
        compressedSize = entry.CompressedSize;
        try {
            const BindingFlags members = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var parts = (IEnumerable)entry.GetType().GetProperty("Parts", members)!.GetValue(entry)!;
            var part = parts.Cast<object>().First();
            var header = entry.GetType().GetProperty("FileHeader", members)!.GetValue(entry)!;
            var saltBytes = (byte[]?)header.GetType().GetProperty("R4Salt", members)!.GetValue(header);
            salt = saltBytes == null ? null : Convert.ToHexString(saltBytes).ToLowerInvariant();
            using var packed = (Stream)part.GetType().GetMethod("GetCompressedStream", members)!.Invoke(part, null)!;
            streamType = packed.GetType().FullName;
            using var target = new MemoryStream();
            var buffer = new byte[65536];
            try {
                while (target.Length < compressedSize) {
                    var count = packed.Read(buffer, 0, (int)Math.Min(buffer.Length, compressedSize - target.Length));
                    if (count == 0) throw new EndOfStreamException("The packed entry ended before its declared length.");
                    target.Write(buffer, 0, count);
                }
            } catch (Exception exception) { error = Failure(exception); }
            bytes = target.ToArray();
        } catch (Exception exception) { error = Failure(exception); }
    }
    var selectedPath = Path.Combine(root, "packed.bin");
    File.WriteAllBytes(selectedPath, bytes);
    cryptoCases.Add(new { name, ordinal, key, salt, streamType, compressedSize, error, selectedPath,
        bytes = bytes.Length, sha256 = Hash(bytes), prefix = Convert.ToHexString(bytes.AsSpan(0, Math.Min(32, bytes.Length))).ToLowerInvariant(),
        sourceUnlocked = Unlocked(noSalt) });
}
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualComicImageProvider = true, actualArchiveReaders = true,
    actualCompressedEntryStreams = true, inputSha256 = Hash(inputBytes), assetBindings, directoryCases, selectedCases, edgeCases, cryptoCases,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
        .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { directories = directoryCases.Count, selected = selectedCases.Count,
    edges = edgeCases.Count, crypto = cryptoCases.Count }));

static string Text(JsonElement value, string key, string fallback = "") =>
    value.TryGetProperty(key, out var found) && found.ValueKind != JsonValueKind.Null ? found.GetString()! : fallback;
static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var found) && found.ValueKind == JsonValueKind.True;
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static object Failure(Exception error) {
    if (error is TargetInvocationException invoked && invoked.InnerException != null) error = invoked.InnerException;
    return new { type = error.GetType().FullName, error.Message, error.HResult };
}
static bool Unlocked(string filename) {
    try { using var exclusive = File.Open(filename, FileMode.Open, FileAccess.ReadWrite, FileShare.None); return true; }
    catch { return false; }
}
static async Task<object> Cover(string filename, string root, string cancel = "") {
    var logs = new List<object>();
    using var cancellation = new CancellationTokenSource();
    if (cancel == "pre") cancellation.Cancel();
    if (cancel == "after-1ms") cancellation.CancelAfter(1);
    var provider = new ComicImageProvider(new CaptureLogger<ComicImageProvider>(logs));
    var result = await provider.GetImage(new Book { Path = filename }, ImageType.Primary, cancellation.Token);
    byte[]? bytes = null;
    string? selectedPath = null;
    if (result.Stream != null) {
        using (result.Stream) {
            using var target = new MemoryStream();
            await result.Stream.CopyToAsync(target);
            bytes = target.ToArray();
        }
        selectedPath = Path.Combine(root, "cover.bin");
        File.WriteAllBytes(selectedPath, bytes);
    }
    return new { hasImage = result.HasImage, format = result.HasImage ? result.Format.ToString() : null,
        bytes = bytes?.Length, sha256 = bytes == null ? null : Hash(bytes), selectedPath, logs,
        cancellationRequested = cancellation.IsCancellationRequested };
}
static async Task<object> ReadOrdinal(string filename, int ordinal, string root, string? password = null) {
    bool opened = false, streamDisposed = false;
    object? openError = null, readError = null;
    using var target = new MemoryStream();
    try {
        using var source = File.OpenRead(filename);
        await using var archive = await ArchiveFactory.OpenAsyncArchive(source,
            new ReaderOptions { Password = password, LeaveStreamOpen = true });
        int index = 0;
        await foreach (var entry in archive.EntriesAsync) {
            if (index++ != ordinal) continue;
            try {
                var stream = await entry.OpenEntryStreamAsync();
                opened = true;
                await using (stream) {
                    var buffer = new byte[65536];
                    try { int count; while ((count = await stream.ReadAsync(buffer)) != 0) target.Write(buffer, 0, count); }
                    catch (Exception exception) { readError = Failure(exception); }
                }
                streamDisposed = true;
            } catch (Exception exception) { openError = Failure(exception); }
            break;
        }
    } catch (Exception exception) { openError = Failure(exception); }
    var bytes = target.ToArray();
    var selectedPath = Path.Combine(root, "entry-" + ordinal + ".bin");
    File.WriteAllBytes(selectedPath, bytes);
    return new { opened, streamDisposed, openError, readError, bytes = bytes.Length, sha256 = Hash(bytes),
        prefix = Convert.ToHexString(bytes.AsSpan(0, Math.Min(32, bytes.Length))).ToLowerInvariant(), selectedPath };
}
static async Task<object> Catalog(string filename, string root) {
    object? archiveError = null;
    var headers = new List<(string? key, long size, bool isDirectory)>();
    try {
        using var source = File.OpenRead(filename);
        await using var archive = await ArchiveFactory.OpenAsyncArchive(source);
        await foreach (var entry in archive.EntriesAsync) headers.Add((entry.Key, entry.Size, entry.IsDirectory));
    } catch (Exception exception) { archiveError = Failure(exception); }
    var entries = new List<object>();
    for (int ordinal = 0; ordinal < headers.Count; ordinal++) {
        var entry = headers[ordinal];
        entries.Add(new { ordinal, entry.key, entry.size, entry.isDirectory,
            read = await ReadOrdinal(filename, ordinal, root) });
    }
    return new { archiveError, entries };
}
static uint Crc(byte[] bytes) {
    uint value = 0xffffffff;
    foreach (var b in bytes) { value ^= b; for (int bit = 0; bit < 8; bit++) value = (value & 1) != 0 ? (value >> 1) ^ 0xedb88320 : value >> 1; }
    return ~value;
}
static byte[] Name(JsonElement entry) {
    var ansi = entry.TryGetProperty("nameHex", out var raw) ? Convert.FromHexString(raw.GetString()!) : Encoding.UTF8.GetBytes(Text(entry, "key"));
    if (!entry.TryGetProperty("unicode", out var unicode)) return ansi;
    using var target = new MemoryStream();
    target.Write(ansi); target.WriteByte(0);
    if (unicode.TryGetProperty("copyLength", out var length)) {
        target.WriteByte(0); target.WriteByte(0xc0);
        var correction = unicode.TryGetProperty("correction", out var found) ? found.GetInt32() : 0;
        target.WriteByte((byte)(length.GetInt32() - 2 | (correction != 0 ? 0x80 : 0)));
        if (correction != 0) target.WriteByte((byte)correction);
    } else {
        var mode = unicode.GetProperty("mode").GetInt32();
        var text = Text(unicode, "text");
        var commands = text.Select(character => (mode, character)).Concat(Text(unicode, "suffix").Select(character => (0, character))).ToArray();
        target.WriteByte((byte)(mode == 1 ? text[0] >> 8 : 0));
        for (int offset = 0; offset < commands.Length; offset += 4) {
            int flags = 0;
            for (int index = 0; index < 4 && offset + index < commands.Length; index++) flags |= commands[offset + index].Item1 << (6 - index * 2);
            target.WriteByte((byte)flags);
            foreach (var (command, character) in commands.Skip(offset).Take(4)) {
                target.WriteByte((byte)character);
                if (command == 2) target.WriteByte((byte)(character >> 8));
            }
        }
    }
    return target.ToArray();
}
static byte[] Rar4Block(byte type, ushort flags, byte[] body) {
    var header = new byte[7 + body.Length];
    header[2] = type; BitConverter.TryWriteBytes(header.AsSpan(3), flags); BitConverter.TryWriteBytes(header.AsSpan(5), (ushort)header.Length);
    body.CopyTo(header, 7); BitConverter.TryWriteBytes(header.AsSpan(0), (ushort)Crc(header[2..]));
    return header;
}
static byte[] VInt(long value) {
    var bytes = new List<byte>();
    do { var next = (byte)(value & 127); value >>= 7; bytes.Add((byte)(next | (value != 0 ? 128 : 0))); } while (value != 0);
    return bytes.ToArray();
}
static byte[] Rar5Block(long type, long flags, byte[] body, int? dataSize = null) {
    using var memory = new MemoryStream();
    memory.Write(VInt(type)); memory.Write(VInt(flags));
    if (dataSize.HasValue) memory.Write(VInt(dataSize.Value));
    memory.Write(body);
    var payload = memory.ToArray();
    var size = VInt(payload.Length);
    var header = new byte[4 + size.Length + payload.Length];
    size.CopyTo(header, 4); payload.CopyTo(header, 4 + size.Length);
    BitConverter.TryWriteBytes(header.AsSpan(0), Crc(header[4..]));
    return header;
}
static void WriteStoredArchive(string filename, JsonElement sample) {
    var classic = Text(sample, "format") == "rar4";
    using var stream = File.Create(filename);
    stream.Write(Convert.FromHexString(classic ? "526172211a0700" : "526172211a070100"));
    stream.Write(classic ? Rar4Block(0x73, 0, new byte[6]) : Rar5Block(1, 0, VInt(0)));
    foreach (var entry in sample.GetProperty("entries").EnumerateArray()) {
        var name = classic ? Name(entry) : Encoding.UTF8.GetBytes(Text(entry, "key"));
        var data = Encoding.UTF8.GetBytes(Text(entry, "text"));
        bool directory = Flag(entry, "directory");
        using var memory = new MemoryStream();
        if (classic) {
            using var body = new BinaryWriter(memory, Encoding.UTF8, true);
            body.Write((uint)data.Length); body.Write((uint)data.Length); body.Write((byte)2); body.Write(Crc(data));
            body.Write(0u); body.Write((byte)20); body.Write((byte)0x30); body.Write((ushort)name.Length); body.Write(directory ? 0x10u : 0x20u); body.Write(name);
            var flags = (ushort)(0x8000 | (directory ? 0xe0 : 0) | (Flag(entry, "unicodeFlag") || entry.TryGetProperty("unicode", out _) ? 0x200 : 0));
            stream.Write(Rar4Block(0x74, flags, memory.ToArray()));
        } else {
            memory.Write(VInt(directory ? 5 : 4)); memory.Write(VInt(data.Length)); memory.Write(VInt(directory ? 0x10 : 0x20));
            memory.Write(BitConverter.GetBytes(Crc(data))); memory.Write(VInt(0)); memory.Write(VInt(0)); memory.Write(VInt(name.Length)); memory.Write(name);
            stream.Write(Rar5Block(2, 2, memory.ToArray(), data.Length));
        }
        stream.Write(data);
    }
    stream.Write(classic ? Rar4Block(0x7b, 0, []) : Rar5Block(5, 0, VInt(0)));
}
static byte[] Mutate(byte[] source, string mutation) {
    using var output = new MemoryStream();
    output.Write(source, 0, 7);
    bool changed = false;
    for (int offset = 7; offset + 7 <= source.Length;) {
        var length = BitConverter.ToUInt16(source, offset + 5);
        var flags = BitConverter.ToUInt16(source, offset + 3);
        var packed = (flags & 0x8000) != 0 ? BitConverter.ToInt32(source, offset + 7) : 0;
        var header = source.AsSpan(offset, length).ToArray();
        if (header[2] == 0x74) {
            var nameOffset = (flags & 0x100) != 0 ? 40 : 32;
            var nameEnd = nameOffset + BitConverter.ToUInt16(header, 26);
            if (Encoding.UTF8.GetString(header, nameOffset, nameEnd - nameOffset).Contains("test.jpg", StringComparison.Ordinal)) {
                if (mutation == "bad-crc") header[16] ^= 1;
                else if (mutation == "wrong-salt") header[nameEnd] ^= 1;
                else if (mutation == "no-salt") {
                    header = [..header[..nameEnd], ..header[(nameEnd + 8)..]];
                    BitConverter.TryWriteBytes(header.AsSpan(3), (ushort)(flags & ~0x400));
                    BitConverter.TryWriteBytes(header.AsSpan(5), (ushort)header.Length);
                } else throw new InvalidDataException("Unknown archive mutation.");
                BitConverter.TryWriteBytes(header.AsSpan(0), (ushort)Crc(header[2..])); changed = true;
            }
        }
        output.Write(header); output.Write(source, offset + length, packed); offset += length + packed;
    }
    if (!changed) throw new InvalidDataException("The declared selected header was not found.");
    return output.ToArray();
}
public sealed class CaptureLogger<T>(List<object> entries) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) =>
        entries.Add(new { level = level.ToString(), exception = error == null ? null : new { type = error.GetType().FullName, error.Message } });
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
