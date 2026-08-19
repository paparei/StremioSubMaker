'use strict';

// Per-request context for addon routes. The SDK router is cached per config,
// so client-type flags (e.g. Nuvio) must travel via AsyncLocalStorage.
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

function isNuvioRequestContext() {
  return requestContext.getStore()?.nuvio === true;
}

module.exports = { requestContext, isNuvioRequestContext };
