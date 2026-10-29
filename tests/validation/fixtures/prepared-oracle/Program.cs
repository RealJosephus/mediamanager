using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var input = File.ReadAllBytes(args[0]);
var output = Path.GetFullPath(args[1]);
var state = Path.Combine(Path.GetDirectoryName(output)!, "state.txt");
var previous = File.Exists(state) ? File.ReadAllText(state) : null;
var digest = Convert.ToHexStringLower(SHA256.HashData(input));
File.WriteAllText(state, digest, new UTF8Encoding(false));
File.WriteAllText(output, JsonSerializer.Serialize(new {
    processId = Environment.ProcessId,
    inputSha256 = digest,
    inputBase64 = Convert.ToBase64String(input),
    environmentValue = Environment.GetEnvironmentVariable("ORACLE_FIXTURE_VALUE"),
    outputRoot = Path.GetDirectoryName(output),
    previousState = previous
}), new UTF8Encoding(false));
Console.WriteLine("Completed isolated oracle input " + digest);
if (args.Length > 2) File.AppendAllText(args[2], "\nChanged by the isolated process.\n");
