using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Common;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Input>(inputBytes) ?? throw new InvalidOperationException("Missing input.");
var results = new List<object>();
foreach (var sample in input.Cases) {
    var sourceBytes = File.ReadAllBytes(sample.FileName);
    var sourceSha256 = Convert.ToHexStringLower(SHA256.HashData(sourceBytes));
    if (!string.Equals(sourceSha256, sample.SourceSha256, StringComparison.Ordinal)) {
        throw new InvalidOperationException($"Source digest changed for {sample.Name}.");
    }
    var user = new User(sample.UserName, "controlled.authentication", "controlled.password-reset") { Id = Guid.Parse(sample.UserId) };
    Change? change = null;
    object? HandleUsers(MethodInfo method, object?[]? values) => method.Name switch {
        "GetUserByName" => Lookup((string)values![0]!),
        "ChangePassword" => ChangePassword((Guid)values![0]!, (string)values[1]!),
        _ => throw new NotSupportedException($"Unexpected IUserManager call: {method.Name}")
    };
    User? Lookup(string name) {
        return string.Equals(name, sample.UserName, StringComparison.Ordinal) ? user : null;
    }
    Task ChangePassword(Guid userId, string pin) {
        if (change is not null) throw new InvalidOperationException("ChangePassword was called more than once.");
        change = new(userId, pin);
        return Task.CompletedTask;
    }
    var users = Stub.Make<IUserManager>(HandleUsers);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_ProgramDataPath" ? sample.ProgramData
        : throw new NotSupportedException($"Unexpected paths call: {method.Name}"));
    var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_ApplicationPaths" ? paths
        : throw new NotSupportedException($"Unexpected configuration call: {method.Name}"));
    var appHost = Stub.Make<IApplicationHost>((method, _) => method.Name == "Resolve" && method.IsGenericMethod
        && method.GetGenericArguments().Length == 1 && method.GetGenericArguments()[0] == typeof(IUserManager) ? users
        : throw new NotSupportedException($"Unexpected application-host call: {method.Name}"));
    var provider = new DefaultPasswordResetProvider(configuration, appHost);
    var redemption = await provider.RedeemPasswordResetPin(sample.RedeemPin);
    if (change is null) throw new InvalidOperationException("Native did not request a password change.");
    results.Add(new { sample.Name, SourceSha256 = sourceSha256, redemption.Success, redemption.UsersReset,
        ChangedUserId = change.UserId.ToString("N"), RequestedPin = change.Pin,
        FileDeleted = !File.Exists(sample.FileName) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    Results = results,
}, new JsonSerializerOptions { WriteIndented = true }));

public sealed class Input {
    public required ResetCase[] Cases { get; init; }
}
public sealed class ResetCase {
    public required string Name { get; init; }
    public required string UserId { get; init; }
    public required string UserName { get; init; }
    public required string ProgramData { get; init; }
    public required string FileName { get; init; }
    public required string SourceSha256 { get; init; }
    public required string RedeemPin { get; init; }
}
public sealed record Change(Guid UserId, string Pin);
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
}
