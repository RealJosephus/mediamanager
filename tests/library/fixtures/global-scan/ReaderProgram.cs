using System.Text.Json;
using System.Text.Json.Nodes;
using Emby.Server.Implementations.Data;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var factory=new SqlFactory(args[0]);
using var db=factory.CreateDbContext();
var aggregate=db.BaseItems.AsNoTracking().Single(item=>item.Type==typeof(AggregateFolder).FullName);
var original=aggregate.Data!;
var variants=new List<(string Name,string Data)> { ("actual-persisted-aggregate",original) };
var extra=JsonNode.Parse(original)!.AsObject();
foreach(var child in extra["VirtualChildren"]!.AsArray())child!.AsObject()["IsRoot"]=false;
variants.Add(("folder-IsRoot-extra",extra.ToJsonString()));
var ignored=JsonNode.Parse(original)!.AsObject();ignored["VirtualChildren"]="not an array";
variants.Add(("readonly-container-invalid-token",ignored.ToJsonString()));
var results=new List<object>();
foreach(var variant in variants)
{
    aggregate.Data=variant.Data;
    var cold=(AggregateFolder)BaseItemRepository.DeserializeBaseItem(aggregate,NullLogger.Instance,null)!;
    results.Add(new { variant.Name,virtualChildren=cold.VirtualChildren.Count,cold.Id,cold.Path,cold.IsRoot,
        physicalLocations=cold.PhysicalLocations,serializedData=JsonSerializer.Serialize(cold,Jellyfin.Extensions.Json.JsonDefaults.Options) });
}
await using var output=new FileStream(args[1],FileMode.CreateNew,FileAccess.Write,FileShare.Read);
await JsonSerializer.SerializeAsync(output,new { actualBaseItemRepositoryReader=true,actualSqliteSource=true,results },new JsonSerializerOptions { WriteIndented=true });
