using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging.Abstractions;

public static class NativeReader
{
    static List<T> Rows<T>(SqliteConnection connection, string table) where T : class
    {
        using var command = connection.CreateCommand(); command.CommandText = $"SELECT * FROM {table}";
        using var reader = command.ExecuteReader(); var rows = new List<T>();
        while (reader.Read())
        {
            var item = Activator.CreateInstance<T>();
            for (int i = 0; i < reader.FieldCount; i++)
            {
                var property = typeof(T).GetProperty(reader.GetName(i)); if (property?.CanWrite != true) continue;
                if (reader.IsDBNull(i)) { property.SetValue(item, null); continue; }
                var type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
                object value = type == typeof(Guid) ? Guid.Parse(reader.GetString(i)) : type == typeof(DateTime) ? DateTime.Parse(reader.GetString(i), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal) : type.IsEnum ? Enum.ToObject(type, reader.GetInt32(i)) : Convert.ChangeType(reader.GetValue(i), type, CultureInfo.InvariantCulture);
                property.SetValue(item, value);
            }
            rows.Add(item);
        }
        return rows;
    }
    public static void Run(string filename, string output)
    {
        SQLitePCL.Batteries_V2.Init();
        using var connection = new SqliteConnection($"Data Source={filename};Mode=ReadOnly"); connection.Open();
        var entity = Rows<BaseItemEntity>(connection, "BaseItems").Single(item => item.Id == Guid.Parse("71717171-7171-7171-7171-717171717171"));
        entity.Provider = Rows<BaseItemProvider>(connection, "BaseItemProviders").Where(row => row.ItemId == entity.Id).ToArray();
        entity.LockedFields = Rows<BaseItemMetadataField>(connection, "BaseItemMetadataFields").Where(row => row.ItemId == entity.Id).ToArray();
        var item = (Audio)BaseItemMapper.DeserializeBaseItem(entity, NullLogger.Instance, null)!;
        var repository = new MediaStreamRepository(null!, DispatchProxy.Create<IServerApplicationHost, ReaderProxy>(), DispatchProxy.Create<ILocalizationManager, ReaderProxy>());
        var mapper = typeof(MediaStreamRepository).GetMethods(BindingFlags.NonPublic | BindingFlags.Instance).Single(method => method.Name == "Map" && method.GetParameters().Length == 1);
        var streams = Rows<Jellyfin.Database.Implementations.Entities.MediaStreamInfo>(connection, "MediaStreamInfos").Where(row => row.ItemId == item.Id).OrderBy(row => row.StreamIndex)
            .Select(row => (MediaStream)mapper.Invoke(repository, [row])!).Select(stream => new { stream.Index, stream.Type, stream.Codec, stream.Path, stream.Language, stream.IsExternal });
        var options = new JsonSerializerOptions { WriteIndented = true }; options.Converters.Add(new JsonStringEnumConverter());
        File.WriteAllText(output, JsonSerializer.Serialize(new { item = new { item.Name, item.Path, item.IsLocked, RunTimeTicks = item.RunTimeTicks.ToString(), item.Container, item.LyricFiles, item.HasLyrics }, streams }, options));
    }
}
public class ReaderProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? values) => method!.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? values![0] : method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
}
