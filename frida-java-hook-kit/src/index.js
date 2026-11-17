import HookManager from './manager.js'
import HookCache, { makeMethodKey } from './cache.js'
import { resolveOverload, resolveAllOverloads, signatureOf, OverloadError } from './overload.js'
import { bindOriginal, makeInvocationHandler, passthroughHandler } from './invocation.js'

/**
 * Convenience entry point: build a manager and install one batch in a single
 * Java.perform() attachment.
 */
export function hookBatch (specs, options = {}) {
  const manager = new HookManager(options)
  const report = manager.installBatch(specs)
  return { manager, ...report }
}

export {
  HookManager,
  HookCache,
  makeMethodKey,
  resolveOverload,
  resolveAllOverloads,
  signatureOf,
  OverloadError,
  bindOriginal,
  makeInvocationHandler,
  passthroughHandler
}

export default HookManager
