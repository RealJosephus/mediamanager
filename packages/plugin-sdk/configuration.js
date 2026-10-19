import { createConfigurationReader } from '../../src/core/configuration-xml.js';
import { createConfigurationWriter, loadConfigurationFile } from '../../src/core/configuration-file.js';

export function nativeConfiguration(model, root) {
  const reader=createConfigurationReader(model), serialize=createConfigurationWriter(model);
  const definition=model.definitions[model.roots[root].type.reference];
  return {
    reader, serialize,
    fields:Object.fromEntries(Object.entries(definition.fields).map(([name,field])=>[name,{...field.type,nullable:field.nullable}])),
    async load(filename, options={}) {return filename?loadConfigurationFile(filename,root,{...options,reader,serialize}):reader.defaultConfiguration(root);},
    validate(values, base=reader.defaultConfiguration(root)) {
      for(const [name,value]of Object.entries(values)) {
        const field=definition.fields[name];if(!field)throw new TypeError(`Unknown plugin configuration field: ${name}`);
        const kind=field.type.kind;
        if(value===null){if(!field.nullable&&kind!=='string'&&kind!=='array')throw new TypeError(`Invalid plugin configuration field: ${name}`);continue;}
        if(kind==='boolean'&&typeof value!=='boolean'||kind==='string'&&typeof value!=='string'
          ||kind==='integer'&&(!Number.isSafeInteger(value)||field.type.bits===32&&(value < -2147483648||value>2147483647))
          ||kind==='array'&&(!Array.isArray(value)||value.some(item=>typeof item!=='string'))
          ||kind==='number'&&(typeof value!=='number'||!Number.isFinite(value)))throw new TypeError(`Invalid plugin configuration field: ${name}`);
      }
      const merged={...base,...values};
      return reader.parseConfigurationXml(serialize(root,merged),root);
    }
  };
}
