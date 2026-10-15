import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [output] = process.argv.slice(2);
if (!output) throw new Error('A new oracle output directory is required.');
await mkdir(output, { recursive: false });
const source = path.resolve('tools/compat/SyncPlayOracle.cs').replaceAll('\\', '/');
await writeFile(path.join(output, 'SyncPlayOracle.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Compile Include="${source}" /></ItemGroup></Project>`);
