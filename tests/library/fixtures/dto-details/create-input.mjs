import { writeFile } from 'node:fs/promises';
const cases=[];
const person=(Name,other={})=>({Type:'Person',Name,...other});
const credit=(Name,Type='Actor',other={})=>({Name,Type,...other});
const addPeople=(name,entities,people,user)=>cases.push({name,kind:'people',entities,people,...user?{user}:{}});
addPeople('people-canonical-and-missing',[person('Present')],[credit('Present'),credit('Missing')]);
addPeople('people-same-name-wrong-id',[person('Actor',{Canonical:false,Id:'20000000-0000-0000-0000-000000000001'})],[credit('Actor')]);
addPeople('people-wrong-id-and-canonical',[person('Actor',{Canonical:false,Id:'20000000-0000-0000-0000-000000000001'}),person('Actor')],[credit('Actor')]);
addPeople('people-role-empty-null',[person('Actor')],[credit('Actor','Actor',{Role:''}),credit('Actor','Director',{Role:null})]);
addPeople('people-type-stable-order',['Other','Composer','Producer','Writer','Director','Guest','Actor','Artist','Author'].map(Name=>person(Name)),[
  credit('Other','Unknown'),credit('Composer','Composer'),credit('Producer','Producer'),credit('Writer','Writer'),credit('Director','Director'),credit('Guest','GuestStar'),credit('Actor'),credit('Artist','Artist'),credit('Author','Author')]);
addPeople('people-explicit-order',[person('Actor'),person('Director'),person('Writer'),person('Producer')],[
  credit('Actor','Actor',{SortOrder:2147483647}),credit('Director','Director',{SortOrder:-1}),credit('Writer','Writer',{SortOrder:0}),credit('Producer','Producer',{SortOrder:null})]);
addPeople('people-max-and-null-stable',[person('Max'),person('Null')],[credit('Max','Composer',{SortOrder:2147483647}),credit('Null','Producer',{SortOrder:null})]);
addPeople('people-case-insensitive-credit-names',[person('Actor')],[credit('aCTOR','Actor',{Role:'one'}),credit('Actor','Director',{Role:'two'})]);
addPeople('people-blocked-tags',[person('Hidden',{Tags:['SPOILER']}),person('Visible')],[credit('Hidden'),credit('Visible')],{BlockedTags:['spoiler']});
addPeople('people-allowed-tags-exempt',[person('Actor')],[credit('Actor')],{AllowedTags:['allowed']});
addPeople('people-block-unrated-exempt',[person('Actor')],[credit('Actor')],{BlockUnratedItems:['Other']});
addPeople('people-no-related-media-exempt',[person('Actor')],[credit('Actor')],{EnabledFolders:['40000000-0000-0000-0000-000000000001']});
const image=(Path,BlurHash)=>({Path,Type:'Primary',DateModified:'2026-09-26T00:00:00Z',BlurHash,Width:2,Height:3});
addPeople('people-image-hashes',[person('No image'),person('First',{Image:image('D:\\synthetic\\first.jpg','blur-first')}),person('Second',{Image:image('D:\\synthetic\\second.jpg','blur-second')}),person('Last')],[
  credit('No image'),credit('First'),credit('Second'),credit('Last')]);
addPeople('people-image-without-blurhash',[person('Actor',{Image:image('D:\\synthetic\\actor.jpg',null)})],[credit('Actor')]);
for(const Type of ['Movie','Video','MusicVideo','Audio','AudioBook','MusicAlbum','MusicArtist','Book','Person']) cases.push({name:'names-'+Type,kind:'names',item:{Type,Name:'Synthetic',Genres:['Rock','A:B',''],Studios:['Studio','A:B','']}});
const itemId='10000000-0000-0000-0000-000000000001',albumId='10000000-0000-0000-0000-000000000002',folderId='10000000-0000-0000-0000-000000000003';
const addFloat=(name,items)=>cases.push({name,kind:'float',query:itemId,items});
addFloat('float-scalar-ratings-gain',[{Type:'Movie',Id:itemId,Name:'Synthetic',CriticRating:7.1,CommunityRating:8.2,NormalizationGain:0.1}]);
addFloat('float-lufs-overrides-gain',[{Type:'Movie',Id:itemId,Name:'Synthetic',CriticRating:0.1,CommunityRating:0,NormalizationGain:0.1,LUFS:-18.1}]);
addFloat('float-negative-zero',[{Type:'Movie',Id:itemId,Name:'Synthetic',CriticRating:JSON.rawJSON('-0'),CommunityRating:-0.1,NormalizationGain:JSON.rawJSON('-0')}]);
addFloat('float-audio-album-gain',[{Type:'MusicAlbum',Id:albumId,Name:'Synthetic Album',NormalizationGain:0.2},{Type:'Audio',Id:itemId,Name:'Synthetic',ParentId:albumId,CriticRating:7.1,CommunityRating:8.2,NormalizationGain:0.1}]);
addFloat('float-audio-nested-album-lufs',[{Type:'MusicAlbum',Id:albumId,Name:'Synthetic Album',NormalizationGain:0.2,LUFS:-20.3},{Type:'Folder',Id:folderId,Name:'CD1',ParentId:albumId},{Type:'Audio',Id:itemId,Name:'Synthetic',ParentId:folderId,CriticRating:7.1,CommunityRating:8.2,LUFS:-18.1}]);
addFloat('float-audiobook-album-gain',[{Type:'MusicAlbum',Id:albumId,Name:'Synthetic Album',NormalizationGain:0.2},{Type:'AudioBook',Id:itemId,Name:'Synthetic',ParentId:albumId,NormalizationGain:0.1}]);
addFloat('float-null-fields',[{Type:'Movie',Id:itemId,Name:'Synthetic',CriticRating:null,CommunityRating:null,NormalizationGain:null,LUFS:null}]);
addPeople('people-role-participates-in-type-rank',[person('Director as Actor'),person('Actor as Writer'),person('Director')],[
  credit('Director','Director'),credit('Director as Actor','Director',{Role:'aCtOr'}),credit('Actor as Writer','Actor',{Role:'Writer'})]);
addPeople('people-database-enum-parsing', ['Lowercase','NumberKnown','NumberUnknown','Composite','Invalid'].map(Name=>person(Name)),
  ['actor','1','99','Actor, Director','Invalid Native Type'].map((PersistedPersonType,index)=>credit(['Lowercase','NumberKnown','NumberUnknown','Composite','Invalid'][index],'Unknown',{PersistedPersonType})));
await writeFile(new URL('input.json',import.meta.url),JSON.stringify({programDataPath:'D:\\isolated-dto-details',cases},null,2)+'\n');
