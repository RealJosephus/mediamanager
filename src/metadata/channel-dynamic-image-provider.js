/** ChannelImageProvider delegates to the installed IChannel equivalent. The
 * refresh host owns these callbacks and the plugin host owns provider work. */
export function createChannelDynamicImagePlugin({ channels }) {
  if (typeof channels?.getMetadataProvider !== 'function') throw new TypeError('Channel images require the installed channel inventory.');
  const supported = async (item, options) => (await channels.getMetadataProvider(item)).getSupportedChannelImages(options);
  return { id: 'builtin-channel-images', name: 'Channel Images', providers: [{
    id: 'channel-images', name: 'Channel Image Provider', kind: 'image', imageSource: 'dynamic', itemTypes: ['Channel'],
    async hasChanged(item, options = {}) {
      const types = await supported(item, options), images = options.images ?? item.ImageInfos;
      return types.some(type => !images.some(image => image.Type === type));
    },
    imageTypesFor: supported,
    async getImage(item, { type, ...options } = {}) { return (await channels.getMetadataProvider(item)).getChannelImage(type, options); },
  }] };
}
