using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Dto;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;

using var document = JsonDocument.Parse(File.ReadAllBytes(args[1]));
var results = new List<object>();
var fields = document.RootElement.GetProperty("fields").EnumerateArray().Select(value => value.GetString()!).ToHashSet();
foreach (var sample in document.RootElement.GetProperty("dtoCases").EnumerateArray()) {
    var item = new Photo { Id = Guid.Parse("df100000-0000-0000-0000-000000000001") };
    foreach (var field in sample.GetProperty("values").EnumerateObject()) {
        var property = typeof(Photo).GetProperty(field.Name)!;
        property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, JsonDefaults.Options));
    }
    var byId = new Dictionary<Guid, BaseItem>();
    foreach (var parent in sample.GetProperty("parents").EnumerateArray()) {
        var id = parent.GetProperty("Id").GetGuid();
        var value = parent.GetProperty("Type").GetString() == "PhotoAlbum" ? (Folder)new PhotoAlbum() : new Folder();
        value.Id = id; value.Name = parent.GetProperty("Name").GetString()!;
        if (parent.TryGetProperty("ParentId", out var ancestor)) value.ParentId = ancestor.GetGuid();
        byId[id] = value;
    }
    if (sample.TryGetProperty("parentId", out var parentId)) item.ParentId = parentId.GetGuid();
    if (sample.TryGetProperty("ownerId", out var ownerId)) item.OwnerId = ownerId.GetGuid();
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetItemById"
        ? byId.GetValueOrDefault((Guid)values![0]!) : Stub.Default(method.ReturnType));
    var dto = new BaseItemDto();
    typeof(DtoService).GetMethod("SetPhotoProperties", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [dto, item]);
    var wire = JsonSerializer.SerializeToElement(dto, JsonDefaults.Options);
    results.Add(new { name = sample.GetProperty("name").GetString(), wire = wire.EnumerateObject()
        .Where(property => fields.Contains(property.Name)).ToDictionary(property => property.Name, property => property.Value.Clone()) });
}
foreach (var sample in document.RootElement.GetProperty("aspectCases").EnumerateArray()) {
    var item = new Photo { Width = sample.GetProperty("width").GetInt32(), Height = sample.GetProperty("height").GetInt32(),
        Orientation = JsonSerializer.Deserialize<ImageOrientation?>(sample.GetProperty("orientation").GetRawText(), JsonDefaults.Options) };
    if (sample.GetProperty("kind").GetString() != "none") item.ImageInfos = [new ItemImageInfo {
        Path = sample.GetProperty("kind").GetString() == "remote" ? "HTTPodd:path" : "Z:\\photos\\sample.jpg", Type = ImageType.Primary,
        Width = sample.GetProperty("imageWidth").GetInt32(), Height = sample.GetProperty("imageHeight").GetInt32() }];
    var calls = 0;
    var processor = Stub.Make<IImageProcessor>((method, _) => {
        if (method.Name != "GetImageDimensions") return Stub.Default(method.ReturnType);
        calls++; if (sample.GetProperty("kind").GetString() == "error") throw new IOException("Controlled dimension failure.");
        return new ImageDimensions(sample.GetProperty("imageWidth").GetInt32(), sample.GetProperty("imageHeight").GetInt32());
    });
    var service = (DtoService)RuntimeHelpers.GetUninitializedObject(typeof(DtoService));
    typeof(DtoService).GetField("_imageProcessor", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, processor);
    typeof(DtoService).GetField("_logger", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, NullLogger<DtoService>.Instance);
    results.Add(new { name = sample.GetProperty("name").GetString(), ratio = service.GetPrimaryImageAspectRatio(item), calls });
}
File.WriteAllText(args[0], JsonSerializer.Serialize(new { inputSha256 = Hash(File.ReadAllBytes(args[1])), results,
    scope = "Actual DtoService.SetPhotoProperties and JsonDefaults serialization; actual GetPrimaryImageAspectRatio and Photo fallback. Parent repository, dimensions and logger are controlled. No native SQL, static decoder or HTTP claimed.",
    assemblies = new[] { typeof(Photo).Assembly, typeof(DtoService).Assembly, typeof(JsonDefaults).Assembly, typeof(BaseItemDto).Assembly }.Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
