// Actual MovieNfoParser and UserDataManager with EF SQLite persistence.
using System.Data.Common;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.XbmcMetadata.Configuration;
using MediaBrowser.XbmcMetadata.Parsers;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using DatabaseUser = Jellyfin.Database.Implementations.Entities.User;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var outputRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(outputRoot);
var results = new List<object>();
var ordinal = 0;

foreach (var sample in input.EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var sampleRoot = Path.Combine(outputRoot, $"{ordinal++:D2}");
    Directory.CreateDirectory(sampleRoot);
    var databasePath = Path.Combine(sampleRoot, "native.db");
    var rehydrateFailure = new RehydrateFailureInterceptor
    {
        Enabled = sample.TryGetProperty("rehydrateFailure", out var rehydrateFailureProperty)
            && rehydrateFailureProperty.GetBoolean()
    };
    var factory = new SqlFactory(databasePath, rehydrateFailure);
    var user = new DatabaseUser("NFO UserData", "controlled-auth", "controlled-reset")
    {
        Id = Guid.Parse("10000000-0000-0000-0000-000000000001")
    };
    var itemId = Guid.Parse("20000000-0000-0000-0000-000000000001");
    using (var setup = factory.CreateDbContext())
    {
        setup.Database.EnsureCreated();
        setup.Users.Add(user);
        setup.BaseItems.Add(new BaseItemEntity
        {
            Id = itemId,
            Type = "MediaBrowser.Controller.Entities.Movies.Movie",
            Data = "{}",
            Name = "NFO UserData"
        });
        setup.SaveChanges();
    }

    var paths = DispatchProxy.Create<IServerApplicationPaths, PathsProxy>();
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var configurationControl = (ConfigurationProxy)(object)configuration;
    configurationControl.Paths = paths;
    configurationControl.Nfo = new XbmcMetadataOptions { UserId = user.Id.ToString("D") };
    BaseItem.ConfigurationManager = configuration;
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var users = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    ((UserManagerProxy)(object)users).User = user;
    var directories = DispatchProxy.Create<IDirectoryService, DirectoryServiceProxy>();
    var userData = new UserDataManager(configuration, factory);
    var movie = new Movie { Id = itemId, Name = "Initial" };
    if (sample.TryGetProperty("providerId", out var providerId)) movie.SetProviderId(MetadataProvider.Tmdb, providerId.GetString()!);

    if (sample.TryGetProperty("sqlFailure", out var sqlFailure))
    {
        using var fault = factory.CreateDbContext();
        var failure = sqlFailure.GetString();
        var sql = failure == "second-node"
            ? "CREATE TRIGGER fail_userdata_update BEFORE UPDATE ON UserData WHEN NEW.PlayCount = 2 BEGIN SELECT RAISE(ABORT, 'Injected user data update failure'); END"
            : $"CREATE TRIGGER fail_userdata_second_key BEFORE INSERT ON UserData WHEN NEW.CustomDataKey = '{itemId:D}' BEGIN SELECT RAISE(ABORT, 'Injected second key failure'); END";
        fault.Database.ExecuteSqlRaw(sql);
    }

    var events = new List<object>();
    using var cancellation = new CancellationTokenSource();
    var eventCount = 0;
    userData.UserDataSaved += (_, eventArgs) =>
    {
        eventCount++;
        events.Add(new
        {
            reason = eventArgs.SaveReason.ToString(),
            keys = eventArgs.Keys.ToArray(),
            data = Projection.Data(eventArgs.UserData),
            itemRows = Projection.Rows(eventArgs.Item.UserData)
        });
        if (sample.TryGetProperty("cancelAfterEvent", out var cancelAfter) && cancelAfter.GetInt32() == eventCount) cancellation.Cancel();
        if (sample.TryGetProperty("eventFailureAt", out var eventFailureAt) && eventFailureAt.GetInt32() == eventCount)
            throw new IOException("Injected user data event failure");
    };
    if (sample.TryGetProperty("preCancelled", out var preCancelled) && preCancelled.GetBoolean()) cancellation.Cancel();

    var filename = Path.Combine(sampleRoot, "movie.nfo");
    File.WriteAllText(filename, sample.GetProperty("xml").GetString()!);
    string? exception = null;
    try
    {
        var result = new MetadataResult<Video> { Item = movie };
        new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, configuration, providers, users, userData, directories)
            .Fetch(result, filename, cancellation.Token);
    }
    catch (Exception error)
    {
        exception = error.GetType().Name;
    }

    object[] rows;
    using (var final = factory.CreateDbContext())
    {
        rows = final.UserData.AsNoTracking().OrderBy(row => row.CustomDataKey).AsEnumerable().Select(Projection.Row).ToArray();
    }
    var direct = userData.GetUserData(user, movie);
    var cached = userData.GetUserDataBatch([movie], user).GetValueOrDefault(movie.Id);
    results.Add(new
    {
        name,
        exception,
        events,
        rows,
        itemRows = Projection.Rows(movie.UserData),
        direct = Projection.Data(direct),
        cached = Projection.Data(cached),
        rehydrateFailureInjected = rehydrateFailure.Fired,
        cancellationRequested = cancellation.IsCancellationRequested
    });
}

File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    results,
    candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual frozen MovieNfoParser, UserDataManager, EF SQLite transactions, per-save cache publication, BaseItem.UserData rehydration and synchronous UserDataSaved events. Cancellation is induced by the first committed event; SQL failures are real SQLite trigger failures. Controlled IConfigurationManager/IUserManager/IProviderManager/IDirectoryService only; no provider host, HTTP or filesystem abstraction."
}, json) + "\n");

public static class Projection
{
    public static object? Data(UserItemData? value) => value is null ? null : new
    {
        value.Key,
        value.Played,
        value.PlayCount,
        lastPlayedDate = value.LastPlayedDate?.ToString("O")
    };

    public static object Row(UserData value) => new
    {
        value.CustomDataKey,
        value.Played,
        value.PlayCount,
        lastPlayedDate = value.LastPlayedDate?.ToString("O")
    };

    public static object[] Rows(IEnumerable<UserData>? values) => values?.OrderBy(value => value.CustomDataKey).Select(Row).ToArray() ?? [];
}

public sealed class SqlFactory(string filename, DbCommandInterceptor interceptor) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>()
            .UseSqlite($"Data Source={filename};Pooling=False")
            .AddInterceptors(interceptor)
            .Options,
        NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public sealed class RehydrateFailureInterceptor : DbCommandInterceptor
{
    public bool Enabled { get; init; }

    public bool Fired { get; private set; }

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        if (Enabled
            && !Fired
            && command.Parameters.Count == 1
            && command.CommandText.Contains("FROM \"UserData\" AS", StringComparison.Ordinal)
            && command.CommandText.Contains("WHERE", StringComparison.Ordinal))
        {
            Fired = true;
            throw new IOException("Injected user data rehydrate SELECT failure");
        }

        return result;
    }
}

public class ConfigurationProxy : DispatchProxy
{
    public IServerApplicationPaths Paths = null!;
    public XbmcMetadataOptions Nfo = new();
    public ServerConfiguration Server = new() { CacheSize = 64 };

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "get_ApplicationPaths" => Paths,
        "get_Configuration" => Server,
        "GetConfiguration" => Nfo,
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class PathsProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "get_ProgramDataPath" or "get_InternalMetadataPath" or "get_TempDirectory" or "get_CachePath" => Path.GetTempPath(),
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UserManagerProxy : DispatchProxy
{
    public DatabaseUser User = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetUserById" => (Guid)args![0]! == User.Id ? User : null,
        "add_OnUserUpdated" or "remove_OnUserUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class ProviderProxy : DispatchProxy
{
    private readonly ExternalIdInfo[] _ids = [new("TMDb", "Tmdb", ExternalIdMediaType.Movie)];
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetExternalIdInfos" => _ids,
        "add_RefreshStarted" or "remove_RefreshStarted" or "add_RefreshCompleted" or "remove_RefreshCompleted"
            or "add_RefreshProgress" or "remove_RefreshProgress" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class DirectoryServiceProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetFile" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class RecordingsProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetActiveRecordingInfo" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
