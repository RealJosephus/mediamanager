export function nfoConfiguration(values = {}) {
  return { UserId: null, ReleaseDateFormat: 'yyyy-MM-dd', SaveImagePathsInNfo: true, EnablePathSubstitution: true, EnableExtraThumbsDuplication: false, ...structuredClone(values) };
}
