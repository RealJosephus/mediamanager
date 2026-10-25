using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Extensions.Json;

var prepare = args[0] == "prepare";
var inputFile = args[prepare ? 1 : 0];
var inputBytes = File.ReadAllBytes(inputFile);
using var document = JsonDocument.Parse(inputBytes);
var input = document.RootElement;
var outputFile = args[2];
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never, WriteIndented = true };
object result;
if (prepare) {
    result = Certificates.Prepare(input, Certificates.Hash(inputBytes), Path.GetDirectoryName(outputFile)!, args[3], args[4]);
} else {
    var preparedBytes = File.ReadAllBytes(args[1]);
    using var preparedDocument = JsonDocument.Parse(preparedBytes);
    var prepared = preparedDocument.RootElement.GetProperty("result");
    var cases = new List<object>();
    foreach (var group in new[] { "listeners", "effects" }) foreach (var sample in input.GetProperty(group).EnumerateArray())
        cases.Add(await HostCases.Run(input, prepared, sample, group, Path.Combine(Path.GetDirectoryName(outputFile)!, "states", sample.GetProperty("name").GetString()!), options));
    result = new { schemaVersion = 1, inputSha256 = Certificates.Hash(inputBytes), preparedSha256 = Certificates.Hash(preparedBytes),
        preparedFiles = new[] { "a", "b", "certificateOnly" }.Select(name => Certificates.FileRecord(prepared.GetProperty(name).GetProperty("file").GetProperty("filename").GetString()!))
            .Append(Certificates.FileRecord(prepared.GetProperty("bad").GetProperty("filename").GetString()!)).ToArray(), cases };
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Certificates.Hash(File.ReadAllBytes(value.Location)) }).OrderBy(value => value.name).ToArray();
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { result, assemblies }, options) + "\n");
