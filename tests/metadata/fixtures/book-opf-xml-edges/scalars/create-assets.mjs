import { mkdir, writeFile } from 'node:fs/promises';
const root='D:/mediamanager-validation/20261016-book-stage/inputs/opf-scalar-edge-1';
await mkdir(root); await mkdir(root+'/assets');
const wrap=body=>'<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">'+body+'</package>';
const readers=[];
for(const[name,bytes]of [
 ['initial-clr-whitespace',Buffer.from(wrap('<dc:creator>A.\u0085B.; C.\ufeffD.</dc:creator>'))],
 ['long-encoding-declaration',Buffer.from('<?xml '+ ' '.repeat(5000)+'version="1.0" encoding="windows-1252"?>'+wrap('<dc:title>\x80uro</dc:title>'),'latin1')]
]){const file=name+'.opf'; await writeFile(root+'/assets/'+file,bytes,{flag:'wx'});readers.push({name,file});}
await writeFile(root+'/input.json',JSON.stringify({readers,opf:[],epubs:[],archives:[]},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root}));
