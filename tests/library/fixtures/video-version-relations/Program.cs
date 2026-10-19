// Actual frozen SaveItems over real EF SQLite; seed rows and failure triggers are controls.
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using Emby.Server.Implementations.Localization;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true, NumberHandling = JsonNumberHandling.AllowReadingFromString };
var common = input.GetProperty("common");
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var directory = Path.GetFullPath(Path.Combine(args[2], name)); Directory.CreateDirectory(directory);
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(method.ReturnType));
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var appHost = Stub.Make<IServerApplicationHost>((method, parameters) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? parameters![0] : Stub.Default(method.ReturnType));
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, _) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), _ => Stub.Default(method.ReturnType)
    });
    var properties = common.GetProperty("item").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone());
    if (sample.TryGetProperty("item", out var changes)) foreach (var property in changes.EnumerateObject()) properties[property.Name] = property.Value.Clone();
    var type = new[] { typeof(BaseItem).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly }
        .SelectMany(assembly => assembly.GetTypes()).Single(t => t.Name == properties["Type"].GetString() && !t.IsAbstract && typeof(BaseItem).IsAssignableFrom(t));
    var subject = (BaseItem)Activator.CreateInstance(type)!;
    foreach (var (field, value) in properties) {
        if (field == "Type") continue;
        if (subject is not Video && field is "LocalAlternateVersions" or "LinkedAlternateVersions") continue;
        var property = type.GetProperty(field)!;
        property.SetValue(subject, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType, json));
    }
    var rows = common.GetProperty("rows").EnumerateArray().Select(row => row.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone())).ToList();
    if (sample.TryGetProperty("rows", out var rowChanges)) foreach (var change in rowChanges.EnumerateArray()) {
        var row = rows.SingleOrDefault(row => row["Id"].GetString() == change.GetProperty("Id").GetString());
        if (row is null) { row = new(); rows.Add(row); }
        foreach (var property in change.EnumerateObject()) row[property.Name] = property.Value.Clone();
    }
    var factory = new SqlFactory(Path.Combine(directory, "native.db"));
    using (var context = factory.CreateDbContext()) {
        context.Database.EnsureCreated(); context.Database.OpenConnection();
        void Seed(string table, Dictionary<string, JsonElement> definition) {
            var entity = context.Model.GetEntityTypes().Single(entity => entity.GetTableName() == table);
            using var command = context.Database.GetDbConnection().CreateCommand();
            var columns = new List<string>(); var parameters = new List<string>();
            foreach (var property in entity.GetProperties()) {
                var column = property.GetColumnName();
                if (property.ValueGenerated == ValueGenerated.OnAdd && !definition.ContainsKey(column)
                    && new[] { typeof(int), typeof(long) }.Contains(property.ClrType)) continue;
                var clrType = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                object? value = definition.TryGetValue(column, out var source)
                    ? JsonSerializer.Deserialize(source.GetRawText(), property.ClrType, json)
                    : property.IsNullable ? null : clrType == typeof(string) ? "" : clrType == typeof(byte[]) ? Array.Empty<byte>()
                    : Activator.CreateInstance(clrType);
                if (property.GetTypeMapping().Converter is { } converter && value is not null) value = converter.ConvertToProvider(value);
                if (value is Enum) value = Convert.ToInt64(value, CultureInfo.InvariantCulture);
                var parameter = command.CreateParameter(); parameter.ParameterName = "@p" + parameters.Count;
                parameter.Value = value ?? DBNull.Value; command.Parameters.Add(parameter);
                columns.Add("\"" + column + "\""); parameters.Add(parameter.ParameterName);
            }
            command.CommandText = "INSERT INTO \"" + table + "\" (" + string.Join(",", columns) + ") VALUES (" + string.Join(",", parameters) + ")";
            command.ExecuteNonQuery();
        }
        foreach (var row in rows) Seed("BaseItems", row);
        if (sample.TryGetProperty("links", out var links)) foreach (var row in links.EnumerateArray()) Seed("LinkedChildren", row.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone()));
        if (sample.TryGetProperty("tables", out var tables)) foreach (var table in tables.EnumerateArray()) foreach (var row in table.GetProperty("rows").EnumerateArray())
            Seed(table.GetProperty("name").GetString()!, row.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone()));
        if (sample.TryGetProperty("trigger", out var trigger)) context.Database.ExecuteSqlRaw(trigger.GetString()!);
    }
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    string? exception = null;
    try {
        var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
        for (var iteration = 0; iteration < (sample.TryGetProperty("repeat", out var repeat) ? repeat.GetInt32() : 1); iteration++)
            persistence.SaveItems([subject], cancellation.Token);
    } catch (Exception error) {
        exception = error.GetType().Name;
        if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) Console.Error.WriteLine(error);
    }
    if (exception != (sample.TryGetProperty("expectException", out var expectedException) ? expectedException.GetString() : null))
        throw new InvalidOperationException("Unexpected exception for " + name + ": " + exception);
    using var final = factory.CreateDbContext();
    var stored = final.BaseItems.AsNoTracking().Where(row => row.Type != "PLACEHOLDER").AsEnumerable().Select(row => new {
        id = row.Id.ToString("D"), name = row.Name, path = row.Path, ownerId = row.OwnerId?.ToString("D"),
        primaryVersionId = row.PrimaryVersionId?.ToString("D"), presentationUniqueKey = row.PresentationUniqueKey, runTimeTicks = row.RunTimeTicks
    }).OrderBy(row => row.id, StringComparer.Ordinal).ToArray();
    var storedLinks = final.LinkedChildren.AsNoTracking().AsEnumerable().Select(row => new {
        parentId = row.ParentId.ToString("D"), childId = row.ChildId.ToString("D"), childType = (int)row.ChildType, sortOrder = row.SortOrder
    }).OrderBy(row => row.parentId, StringComparer.Ordinal).ThenBy(row => row.sortOrder).ToArray();
    var projectedTables = new List<object>();
    if (sample.TryGetProperty("tables", out var projectTables)) {
        final.Database.OpenConnection();
        foreach (var table in projectTables.EnumerateArray()) {
            var tableName = table.GetProperty("name").GetString()!;
            var columns = table.GetProperty("projection").EnumerateArray().Select(v => v.GetString()!).ToArray();
            using var command = final.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT " + string.Join(",", columns.Select(column => "\"" + column + "\"")) + " FROM \"" + tableName + "\"";
            using var reader = command.ExecuteReader(); var projected = new List<string?[]>();
            while (reader.Read()) projected.Add(Enumerable.Range(0, columns.Length).Select(index => reader.IsDBNull(index) ? null : Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture)?.ToLowerInvariant()).ToArray());
            projectedTables.Add(new { name = tableName, rows = projected.OrderBy(row => string.Join("|", row), StringComparer.Ordinal).ToArray() });
        }
    }
    results.Add(new { name, exception, items = stored, links = storedLinks, tables = projectedTables });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(ItemPersistenceService).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly,
    typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualFrozenVideoVersionRelations = true,
    inputSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    results, assemblies,
    scope = "Actual frozen ItemPersistenceService.SaveItems and EF SQLite: ordered typed version links, literal path resolution, local priority/deduplication, child demotion, owned orphan direct removal, real FK cascades and transaction failures. Typed entities, seed rows, virtual paths, library getters, cancellation and SQL triggers are controls. Projects six BaseItems fields plus exact Int64, all LinkedChildren and selected FK/non-FK identifier projections. Excludes the retention placeholder, missing-file discovery/creation, LibraryManager events/cache, savers/images, full scalar mapping, generic DeleteItem and complete library acceptance."
}, json) + "\n");

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
