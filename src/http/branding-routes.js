import { BindingError, noContent } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { bindSplashscreenOptions } from './image-routes.js';
import { BinaryResult } from './binary-result.js';

const string = { type: 'string', clrType: 'System.String', nullable: true };
const schema = { definitions: { BrandingOptionsDto: {
  defaults: { LoginDisclaimer: null, CustomCss: null, SplashscreenEnabled: false },
  fields: { LoginDisclaimer: string, CustomCss: string, SplashscreenEnabled: { type: 'boolean', clrType: 'System.Boolean' } }
} } };
function bindOptions(body, source) {
  if (body == null) throw new BindingError('', 'A non-empty request body is required.');
  return bindJsonModel(body, { schema, root: { type: 'object', reference: 'BrandingOptionsDto', clrType: 'MediaBrowser.Model.Branding.BrandingOptionsDto' }, source });
}
export function registerBrandingRoutes(add, { branding }) {
  if (!branding) return;
  for (const method of ['GET', 'HEAD']) {
    add(method, '/Branding/Configuration', () => branding.getOptions(), { public: true });
    add(method, ['/Branding/Css', '/Branding/Css.css'], () => {
      const bytes = Buffer.from(branding.getOptions().CustomCss ?? '');
      return BinaryResult.bytes(bytes, 'text/css; charset=utf-8', { knownLength: bytes.length === 0 });
    }, { public: true });
    add(method, '/Branding/Splashscreen', context => branding.splashscreen(bindSplashscreenOptions(context), context), { public: true });
    add(method, '/System/Configuration/Branding', () => branding.getOptions({ includeLocation: true }));
  }
  add('POST', '/System/Configuration/Branding', async context => { await branding.updateOptions(context.body); return noContent(); },
    { policy: 'RequiresElevation', body: true, bindBody: bindOptions, bodyParameter: 'configuration', bodyType: 'MediaBrowser.Model.Branding.BrandingOptionsDto' });
  add('POST', '/Branding/Splashscreen', context => branding.upload(context.request), { policy: 'RequiresElevation' });
  add('DELETE', '/Branding/Splashscreen', () => branding.deleteSplashscreen(), { policy: 'RequiresElevation' });
}
