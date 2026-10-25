import path from 'node:path';
export { getMimeType as imageMime } from '../http/mime-types.js';
export function imageExtension(value) {
  const extension = ({ Jpg: '.jpg', Png: '.png', Webp: '.webp', Gif: '.gif', Bmp: '.bmp', Svg: '.svg' })[value];
  if (extension == null) throw Object.assign(new RangeError('Invalid image output format.'), { status: 400 });
  return extension;
}
export function hasDefaultImageOptions(options, source, size) {
  const extension = path.extname(source).toLowerCase().replace('.jpeg', '.jpg');
  if ((options.Quality ?? 100) < 90 || !(options.SupportedOutputFormats ?? ['Jpg', 'Png']).some(format => imageExtension(format) === extension)
    || (options.PercentPlayed ?? 0) !== 0 || options.UnplayedCount != null || options.Blur != null || options.BackgroundColor || options.ForegroundLayer) return false;
  if (!size) return !['Width', 'Height', 'MaxWidth', 'MaxHeight'].some(key => options[key] != null);
  return !(options.Width != null && options.Width !== size.Width || options.Height != null && options.Height !== size.Height
    || options.MaxWidth != null && size.Width > options.MaxWidth || options.MaxHeight != null && size.Height > options.MaxHeight
    || options.FillWidth != null && size.Width > options.FillWidth || options.FillHeight != null && size.Height > options.FillHeight);
}
export function roundEven(value) { const floor = Math.floor(value), remainder = value - floor; return remainder < 0.5 ? floor : remainder > 0.5 ? floor + 1 : floor % 2 ? floor + 1 : floor; }
export function newImageSize(options, size) {
  let Width = size.Width, Height = size.Height;
  if (options.Width > 0 && options.Height > 0) { Width = options.Width; Height = options.Height; }
  else if (options.Height > 0) { Width = roundEven(options.Height / Height * Width); Height = options.Height; }
  else if (options.Width > 0) { Height = roundEven(options.Width / Width * Height); Width = options.Width; }
  if (options.MaxHeight > 0 && options.MaxHeight < Height) { Width = roundEven(options.MaxHeight / Height * Width); Height = options.MaxHeight; }
  if (options.MaxWidth > 0 && options.MaxWidth < Width) { Height = roundEven(options.MaxWidth / Width * Height); Width = options.MaxWidth; }
  if (options.FillWidth || options.FillHeight) { const scale = Math.min(Width / (options.FillWidth || 1), Height / (options.FillHeight || 1)); if (scale >= 1) { Width = Math.ceil(Width / scale); Height = Math.ceil(Height / scale); } }
  if (Width > 0 && Height > 0 && size.Width > 0 && size.Height > 0) { const scale = Math.max(Width / size.Width, Height / size.Height); if (scale > 1) { Width = Math.max(1, Math.min(size.Width, roundEven(Width / scale))); Height = Math.max(1, Math.min(size.Height, roundEven(Height / scale))); } }
  return { Width, Height };
}
