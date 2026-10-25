using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using UtfUnknown;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var samples = new List<object>();
var repetitions = input.GetProperty("repetitions").EnumerateArray().Select(value => value.GetInt32()).ToArray();
var prefixes = input.GetProperty("prefixLengths").EnumerateArray().Select(value => value.GetInt32()).ToArray();
foreach (var language in input.GetProperty("languages").EnumerateArray())
foreach (var label in language.GetProperty("encodings").EnumerateArray())
{
    var encoding = Encoding.GetEncoding(label.GetString()!);
    foreach (var repeat in repetitions)
    foreach (var prefix in prefixes)
    {
        var text = new string('a', prefix) + string.Concat(Enumerable.Repeat(language.GetProperty("text").GetString(), repeat));
        Add($"{language.GetProperty("name").GetString()}-{label.GetString()}-{repeat}-{prefix}", encoding.GetBytes(text));
    }
}
foreach (var value in input.GetProperty("hexCases").EnumerateArray())
    Add(value.GetProperty("name").GetString()!, Convert.FromHexString(value.GetProperty("hex").GetString()!));
if (input.GetProperty("singleBytes").GetBoolean())
    for (var value = 0; value <= 255; value++) Add($"single-byte-{value:x2}", [(byte)value]);
var lengths = input.GetProperty("randomLengths").EnumerateArray().Select(value => value.GetInt32()).ToArray();
for (var index = 0; index < input.GetProperty("randomCases").GetInt32(); index++)
{
    var bytes = new byte[lengths[index % lengths.Length]];
    for (var offset = 0; offset < bytes.Length; offset += 32)
    {
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes($"neutral-charset-{index}-{offset}"));
        hash.AsSpan(0, Math.Min(32, bytes.Length - offset)).CopyTo(bytes.AsSpan(offset));
    }
    Add($"binary-{index}-{bytes.Length}", bytes);
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), samples
}, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));

void Add(string name, byte[] bytes) => samples.Add(new {
    name, bytes = Convert.ToBase64String(bytes),
    buffer = Detect(bytes, false), stream = Detect(bytes, true)
});

object Detect(byte[] bytes, bool stream)
{
    try
    {
        var result = stream ? CharsetDetector.DetectFromStream(new MemoryStream(bytes)) : CharsetDetector.DetectFromBytes(bytes);
        var detected = result.Detected;
        var aboveThreshold = detected is not null && detected.Confidence >= 0.5f;
        var encoding = aboveThreshold && detected?.Encoding is not null ? detected.Encoding : Encoding.UTF8;
        using var reader = new StreamReader(new MemoryStream(bytes), encoding, detectEncodingFromByteOrderMarks: true);
        return new {
            details = result.Details?.Select(detail => new { name = detail.EncodingName, confidence = detail.Confidence,
                encoding = detail.Encoding?.WebName, bom = detail.HasBOM }).ToArray(),
            selection = new { first = detected?.EncodingName, encoding = detected?.Encoding?.WebName,
                bom = detected?.HasBOM ?? false, aboveThreshold, selectedEncoding = encoding.WebName },
            text = reader.ReadToEnd(), error = (string?)null
        };
    }
    catch (Exception error)
    {
        return new { details = (object?)null, selection = (object?)null, text = (string?)null, error = error.GetType().FullName };
    }
}
