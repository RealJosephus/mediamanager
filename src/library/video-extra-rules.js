export const extraRules = Object.freeze([
  ['DirectoryName', 'trailers', 2, 'Video'], ['DirectoryName', 'backdrops', 9, 'Video'],
  ['DirectoryName', 'theme-music', 8, 'Audio'], ['DirectoryName', 'behind the scenes', 3, 'Video'],
  ['DirectoryName', 'deleted scenes', 4, 'Video'], ['DirectoryName', 'interviews', 5, 'Video'],
  ['DirectoryName', 'scenes', 6, 'Video'], ['DirectoryName', 'samples', 7, 'Video'], ['DirectoryName', 'sample', 7, 'Video'],
  ['DirectoryName', 'shorts', 11, 'Video'], ['DirectoryName', 'featurettes', 10, 'Video'],
  ['DirectoryName', 'extras', 0, 'Video'], ['DirectoryName', 'extra', 0, 'Video'],
  ['DirectoryName', 'other', 0, 'Video'], ['DirectoryName', 'clips', 1, 'Video'],
  ['Filename', 'trailer', 2, 'Video'], ['Filename', 'sample', 7, 'Video'],
  ['Filename', 'theme', 8, 'Audio'],
  ['Suffix', '-trailer', 2, 'Video'], ['Suffix', '.trailer', 2, 'Video'],
  ['Suffix', '_trailer', 2, 'Video'], ['Suffix', '- trailer', 2, 'Video'],
  ['Suffix', '-sample', 7, 'Video'], ['Suffix', '.sample', 7, 'Video'],
  ['Suffix', '_sample', 7, 'Video'], ['Suffix', '- sample', 7, 'Video'],
  ['Suffix', '-scene', 6, 'Video'], ['Suffix', '-clip', 1, 'Video'],
  ['Suffix', '-interview', 5, 'Video'], ['Suffix', '-behindthescenes', 3, 'Video'],
  ['Suffix', '-deleted', 4, 'Video'], ['Suffix', '-deletedscene', 4, 'Video'],
  ['Suffix', '-featurette', 10, 'Video'], ['Suffix', '-short', 11, 'Video'],
  ['Suffix', '-extra', 0, 'Video'], ['Suffix', '-other', 0, 'Video']
].map(([ruleType, token, extraType, mediaType]) => Object.freeze({ ruleType, token, extraType, mediaType })));

const extrasFolderNames = new Set(extraRules.filter(rule => rule.ruleType === 'DirectoryName').map(rule => rule.token));
export const isVideoExtraDirectory = name => extrasFolderNames.has(name.toLowerCase());
