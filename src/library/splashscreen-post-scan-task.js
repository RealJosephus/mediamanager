export class SplashscreenPostScanTask {
  constructor({ library, imageGenerator, logger = {} }) {
    if (typeof library?.getSplashscreenImagePaths !== 'function' || typeof imageGenerator?.createSplashscreen !== 'function') {
      throw new TypeError('Splashscreen maintenance requires repository image selection and static image generation.');
    }
    Object.assign(this, { library, imageGenerator, logger, name: 'Splashscreen' });
  }

  // Native maintenance does not observe its cancellation token or report progress.
  async run() {
    const posters = await this.library.getSplashscreenImagePaths('Primary');
    let backdrops = await this.library.getSplashscreenImagePaths('Thumb');
    if (!backdrops.length) {
      this.logger.debug?.('No thumb images found. Using backdrops to generate splashscreen');
      backdrops = await this.library.getSplashscreenImagePaths('Backdrop');
    }
    await this.imageGenerator.createSplashscreen(posters, backdrops);
  }
}
