(function initLogger(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  const prefix = '[中指土地助手]';

  CREIS.logger = {
    debug(...args) { console.debug(prefix, ...args); },
    info(...args) { console.info(prefix, ...args); },
    warn(...args) { console.warn(prefix, ...args); },
    error(...args) { console.error(prefix, ...args); }
  };
})(globalThis);
