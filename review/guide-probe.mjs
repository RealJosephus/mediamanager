import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { compileOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createSchedulesDirectProvider } from '../../plugins/schedules-direct/provider.js';

test('two Schedules Direct days share one program ID and different cached/fresh details', async () => {
  const fixture = new URL('./fixtures/schedules-direct/', import.meta.url);
  const folder=path.join(validationOutputRoot(),'review-guide');
  const project=path.join(folder,'observing-project');
  await fs.mkdir(project,{recursive:true});
  await fs.copyFile(new URL('Oracle.csproj',fixture),path.join(project,'Oracle.csproj'));
  const upstream=await fs.readFile(new URL('Program.cs',fixture),'utf8');
  const before=upstream.split('var importedCache =')[0];
  const after=upstream.slice(upstream.indexOf('public class CachePaths'));
  const observer = `var directory = args[2];
Directory.CreateDirectory(directory);
var paths = DispatchProxy.Create<IApplicationPaths, CachePaths>();
((CachePaths)(object)paths).Directory = directory;
using var handler = new FixtureRoutes(routes);
using var http = new HttpClient(handler);
var factory = new Clients(http);
var info = new ListingsProviderInfo { Username="user",Password="password",ListingsId="A" };
var start = new DateTime(2025,3,1,12,0,0,DateTimeKind.Utc);
using var provider = new SchedulesDirect(NullLogger<SchedulesDirect>.Instance,factory,paths,null!);
var programs = await provider.GetProgramsAsync(info,"21",start,start.AddDays(int.Parse(args[3])).AddHours(1),CancellationToken.None);
await File.WriteAllTextAsync(args[1],JsonSerializer.Serialize(new {names=programs.Select(p=>p.Name).ToArray(),calls=handler.Calls,assembly=Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(typeof(SchedulesDirect).Assembly.Location)))}));
`;
  await fs.writeFile(path.join(project,'Program.cs'),before+observer+after);
  const oracle=await compileOracle({project:path.join(project,'Oracle.csproj'),output:path.join(folder,'build')});
  const base=JSON.parse(await fs.readFile(new URL('input.json',fixture),'utf8'));
  const report={};
  for(const [index,title] of ['Cached title','Fresh title'].entries()){
    const routes=structuredClone(base);
    const detail=routes['POST /programs'][0];
    detail.titles[0].title120=title; detail.hasImageArtwork=false;
    const date=index?'2025-03-02':'2025-03-01';
    routes['POST /schedules/md5']['21'][date]={md5:'day-hash-'+index};
    routes['POST /schedules/md5']['21']['2025-03-01']={md5:'day-hash-0'};
    const schedule=routes['POST /schedules'][0];
    schedule.metadata.startDate=date; schedule.metadata.md5='day-hash-'+index;
    schedule.programs[0].airDateTime=date+'T12:00:00Z';
    const input=path.join(folder,'input-'+index+'.json');
    await fs.writeFile(input,JSON.stringify(routes));
    const native=path.join(folder,'native-'+index);
    await oracle.record({output:native,args:[input,'{output}/programs.json',path.join(folder,'native-cache'),String(index)]});
    const sample=JSON.parse(await fs.readFile(path.join(native,'programs.json'),'utf8'));
    const calls=[];
    const provider=createSchedulesDirectProvider({cachePath:path.join(folder,'candidate-cache'),fileSystem:fs,fetch:async(url,init)=>{
      const key=init.method+' '+new URL(url).pathname.slice('/20141201'.length);calls.push(key);assert.ok(Object.hasOwn(routes,key),key);
      return Response.json(routes[key]);
    }});
    const programs=await provider.getPrograms({Username:'user',Password:'password',ListingsId:'A'},'21','2025-03-01T12:00:00Z',date+'T13:00:00Z');
    report[index]={native:sample,candidate:{names:programs.map(p=>p.Name),calls}};
    assert.equal(sample.names.length,index+1);
    assert.equal(programs.length,index+1);
  }
  await fs.writeFile(path.join(validationOutputRoot(),'review','guide.json'),JSON.stringify(report,null,2));
  assert.deepEqual(report[0].native.names,report[0].candidate.names);
});

