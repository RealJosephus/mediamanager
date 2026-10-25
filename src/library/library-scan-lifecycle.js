const metadataOptions = () => ({ MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true,
  ReplaceAllMetadata: false, ReplaceAllImages: false, ForceSave: false, RemoveOldMetadata: false, RefreshPaths: [] });
const itemType = item => String(item.Type).split('.').at(-1);
const cancellation = error => error?.name === 'AbortError' || error?.code === 'cancelled';

export class LibraryScanLifecycle {
  constructor({ host, monitor, postScanTasks = [], logger = { error() {} } }) {
    const required = ['getAggregateFolder', 'getUserRootFolder', 'clearIgnoreRuleCache', 'invalidateChildren',
      'refreshMetadata', 'validateChildren', 'withChildren', 'collectionDirectoryExists', 'updateInheritedValues'];
    if (!host || required.some(method => typeof host[method] !== 'function')) throw new TypeError('Library scanning requires an authoritative top-level host.');
    if (!monitor || typeof monitor.stop !== 'function' || typeof monitor.start !== 'function') throw new TypeError('Library scanning requires a directory monitor.');
    Object.assign(this, { host, monitor, postScanTasks, logger });
    this.capabilities = Object.freeze({
      ...host.capabilities,
      watchesLibraryDirectories: monitor.capabilities?.watchesLibraryDirectories === true,
      reconcilesTopLevelConfiguration: host.capabilities?.reconcilesTopLevelConfiguration === true,
      // This lifecycle owns task execution, including empty registrations and
      // tasks registered after the host is constructed.
      runsPostScanTasks: true
    });
    this.isScanRunning = false;
  }

  async validateTopLibraryFolders({ signal, removeRoot = false } = {}) {
    const host = this.host;
    await host.clearIgnoreRuleCache();
    const aggregate = await host.getAggregateFolder();
    await host.invalidateChildren(aggregate);
    await host.refreshMetadata(aggregate, { ...metadataOptions(), signal });
    await host.invalidateChildren(aggregate);
    await host.validateChildren(aggregate, { ...metadataOptions(), signal, recursive: false, allowRemoveRoot: removeRoot,
      refreshChildMetadata: true, reportProgress() {} });
    const userRoot = await host.getUserRootFolder();
    await host.invalidateChildren(userRoot);
    await host.refreshMetadata(userRoot, { ...metadataOptions(), signal });
    await host.invalidateChildren(userRoot);
    await host.validateChildren(userRoot, { ...metadataOptions(), signal, recursive: false, allowRemoveRoot: removeRoot,
      refreshChildMetadata: true, reportProgress() {} });
    await host.withChildren(userRoot, async children => {
      for await (const page of children.pages()) for (const child of page) {
        if (child.IsFolder !== true) continue;
        if (itemType(child) === 'CollectionFolder' && !await host.collectionDirectoryExists(child)) await children.markForDeletion(child.Id);
        else await host.refreshMetadata(child, { ...metadataOptions(), signal });
      }
      await children.deleteMarked();
    });
    await host.clearIgnoreRuleCache();
  }

  async runPostScanTasks({ signal, reportProgress = () => {} } = {}) {
    // The native manager snapshots registrations before invoking any task.
    const tasks = [...this.postScanTasks];
    let completed = 0;
    for (const task of tasks) {
      const index = completed;
      try { await task.run({ signal, reportProgress: value => reportProgress((value / 100 + index) / tasks.length * 100) }); }
      catch (error) {
        if (signal?.aborted || cancellation(error)) throw error;
        this.logger.error(error, `Post-scan task ${task.name ?? 'unnamed'} failed`);
      }
      reportProgress(++completed / tasks.length * 100);
    }
    await this.host.updateInheritedValues();
    reportProgress(100);
  }

  async run({ signal, reportProgress = () => {} } = {}) {
    this.isScanRunning = true;
    await this.host.clearIgnoreRuleCache();
    // Stop is outside the native try/finally; a Stop failure leaves scan state set.
    await this.monitor.stop();
    try {
      await this.validateTopLibraryFolders({ signal });
      const aggregate = await this.host.getAggregateFolder();
      await this.host.invalidateChildren(aggregate);
      const scanOptions = { ...metadataOptions(), signal, recursive: true,
        refreshChildMetadata: true, allowRemoveRoot: false,
        reportProgress: (value, detail) => reportProgress(value * 0.96, detail) };
      await this.host.validateChildren(aggregate, scanOptions);
      reportProgress(96);
      await this.runPostScanTasks({ signal, reportProgress: value => reportProgress(96 + value * 0.04) });
      reportProgress(100);
    } finally {
      await this.host.clearIgnoreRuleCache();
      await this.monitor.start();
      this.isScanRunning = false;
    }
  }
}
