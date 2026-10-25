import * as core from '../../../../src/core/configuration-xml.js';
import { createConfigurationWriter, loadConfigurationFile as load } from '../../../../src/core/configuration-file.js';
import coreModel from '../../../../src/core/resources/configuration-model.json' with { type:'json' };
import nfoModel from '../../../../plugins/nfo/configuration-model.json' with { type:'json' };
import tmdbModel from '../../../../plugins/tmdb/configuration-model.json' with { type:'json' };

const models = { nfo:nfoModel, tmdb:tmdbModel };
const reader = root => models[root] ? core.createConfigurationReader(models[root]) : core;
export const parseConfigurationXml = (bytes,root,options) => reader(root).parseConfigurationXml(bytes,root,options);
export const readConfigurationDocument = (bytes,root,options) => reader(root).readConfigurationDocument(bytes,root,options);
export const defaultConfiguration = (root,options) => reader(root).defaultConfiguration(root,options);
export const loadConfigurationFile = (filename,root,options) => load(filename,root,{...options,
  reader:reader(root), serialize:createConfigurationWriter(models[root] ?? coreModel) });
export const model = { ...coreModel, roots:{...coreModel.roots,...nfoModel.roots,...tmdbModel.roots},
  definitions:{...coreModel.definitions,...nfoModel.definitions,...tmdbModel.definitions} };
