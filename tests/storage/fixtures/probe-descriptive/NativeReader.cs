using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Entities;
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
        var entity = Rows<BaseItemEntity>(connection, "BaseItems").Single(item => item.Id == Guid.Parse("D1111111-1111-1111-1111-111111111111"));
        entity.Provider = Rows<BaseItemProvider>(connection,"BaseItemProviders").Where(row => row.ItemId == entity.Id).ToArray();
        entity.LockedFields = Rows<BaseItemMetadataField>(connection,"BaseItemMetadataFields").Where(row => row.ItemId == entity.Id).ToArray();
        var item = (Video)BaseItemMapper.DeserializeBaseItem(entity, NullLogger.Instance, null)!;
        var local = DispatchProxy.Create<ILocalizationManager, LocalizationProxy>();
        var host = DispatchProxy.Create<IServerApplicationHost, HostProxy>();
        var repository = new MediaStreamRepository(null!, host, local);
        var mapper = typeof(MediaStreamRepository).GetMethods(BindingFlags.NonPublic | BindingFlags.Instance).Single(method => method.Name == "Map" && method.GetParameters().Length == 1);
        var streams = Rows<Jellyfin.Database.Implementations.Entities.MediaStreamInfo>(connection,"MediaStreamInfos").Where(row => row.ItemId == item.Id).OrderBy(row=>row.StreamIndex).Select(row => (MediaStream)mapper.Invoke(repository,[row])!).Select(stream=>new {stream.Index,stream.Type,stream.Codec,stream.Path,stream.Language,stream.IsDefault,stream.IsForced,stream.IsHearingImpaired,stream.IsExternal,stream.Width,stream.Height});
        var chapterRepository = new ChapterRepository(null!,null!);
        var chapterMapper = typeof(ChapterRepository).GetMethods(BindingFlags.NonPublic | BindingFlags.Instance).Single(method => method.Name == "Map" && method.GetParameters().Length == 2);
        var chapters = Rows<Chapter>(connection,"Chapters").Where(row=>row.ItemId == item.Id).OrderBy(row=>row.ChapterIndex).Select(row=>(ChapterInfo)chapterMapper.Invoke(chapterRepository,[row,item.Path])!).Select(chapter=>new {chapter.Name,StartPositionTicks=chapter.StartPositionTicks.ToString(CultureInfo.InvariantCulture)});
        var options = new JsonSerializerOptions {WriteIndented=true}; options.Converters.Add(new JsonStringEnumConverter());
        File.WriteAllText(output,JsonSerializer.Serialize(new {item=new {item.Name,item.Overview,item.ProductionYear,item.OfficialRating,item.Genres,item.Studios,item.DefaultVideoStreamIndex,item.SubtitleFiles,item.AudioFiles},streams,chapters},options));
    }
}
public class HostProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? values) => method!.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? values![0] : method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
}
