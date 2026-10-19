import { mkdir, writeFile } from 'node:fs/promises';
const root='D:/mediamanager-validation/20261016-book-stage/inputs/opf-resource-1';await mkdir(root);await mkdir(root+'/assets');
const wrap=body=>'<package xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>'+body+'</dc:title></package>',cases=[];
async function sample(name,xml){const file=name+'.opf';await writeFile(root+'/assets/'+file,xml,{flag:'wx'});cases.push({name,file});}
const entity=(name,value)=>'<!ENTITY '+name+' "'+value+'">';
const dtd=(declarations,body)=>'<!DOCTYPE package ['+declarations.join('')+']>'+wrap(body);
for(const number of [9,10])await sample('expanded-'+number+'-million',dtd([entity('small','x'.repeat(1000)),entity('million','&small;'.repeat(1000))],'&million;'.repeat(number)));
for(const number of [10000000,10000001])await sample('single-entity-'+number,dtd([entity('large','x'.repeat(number))],'&large;'));
await sample('literal-10000001',wrap('x'.repeat(10000001)));
for(const depth of [300,2048]){const declarations=[entity('a0','Deep')];for(let index=1;index<depth;index++)declarations.push(entity('a'+index,'&a'+(index-1)+';'));await sample('entity-depth-'+depth,dtd(declarations,'&a'+(depth-1)+';'));}
await sample('entity-self-cycle',dtd([entity('a','&a;')],'&a;'));
await sample('entity-mutual-cycle',dtd([entity('a','&b;'),entity('b','&a;')],'&a;'));
await writeFile(root+'/input.json',JSON.stringify({cases},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({root,cases:cases.length}));
