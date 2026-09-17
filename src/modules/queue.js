(function initQueue(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};

  class SerialQueue {
    constructor(options) {
      this.delay = options && options.delay || CREIS.CONFIG.requestDelay;
      this.retryCount = (options && options.retryCount) ?? CREIS.CONFIG.retryCount;
    }

    async run(items, worker, onProgress) {
      const results = [];
      for (let index = 0; index < items.length; index += 1) {
        let lastError;
        for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
          try {
            const value = await worker(items[index], index, attempt);
            results.push({ status: 'success', value });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < this.retryCount) await new Promise((resolve) => setTimeout(resolve, this.delay));
          }
        }
        if (lastError) results.push({ status: 'failed', error: lastError.message });
        if (onProgress) onProgress(index + 1, items.length, results[results.length - 1]);
        if (index < items.length - 1) await new Promise((resolve) => setTimeout(resolve, this.delay));
      }
      return results;
    }
  }

  CREIS.SerialQueue = SerialQueue;
})(globalThis);
