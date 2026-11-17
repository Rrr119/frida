import HookCache, { makeMethodKey } from './cache.js'
import { resolveOverload, resolveAllOverloads, signatureOf } from './overload.js'
import { makeInvocationHandler, passthroughHandler } from './invocation.js'

const STATIC_METHOD = 2

/**
 * @typedef {object} HookSpec
 * @property {string} className fully-qualified Java class name
 * @property {string} methodName method to hook
 * @property {string[]} [argTypes] JNI type names; omit for a unique overload,
 *   or set to '*' to hook every overload with the same handler
 * @property {Function} [onEnter] called with (args, ctx) before the original;
 *   its return value is ignored, mutate args/ctx to observe or stash state
 * @property {Function} [onLeave] called with (retval, args, ctx); its return
 *   value replaces the original return value
 * @property {Function} [handler] full-control handler `(args, ctx) => retval`;
 *   takes precedence over onEnter/onLeave
 * @property {boolean} [passthrough=false] install a no-op forwarding hook
 * @property {object} [extras] arbitrary cached resources exposed as `ctx`
 */

/**
 * @typedef {object} InstalledHook
 * @property {string} key cache key of the concrete overload
 * @property {string} className
 * @property {string} methodName
 * @property {string} signature comma-joined parameter type names
 * @property {object} method concrete bridge method wrapper
 * @property {Function} originalImpl the previous `.implementation`, or null
 */

function defaultJava () {
  // frida-java-bridge exports the runtime as its default export.  Resolved
  // lazily so the module can also be unit-tested under plain Node with an
  // injected runtime.
  if (defaultJava.runtime === undefined) {
    defaultJava.runtime = globalThis.Java ?? null
  }
  return defaultJava.runtime
}

export default class HookManager {
  /**
   * @param {object} [options]
   * @param {object} [options.java] explicit frida-java-bridge runtime
   * @param {HookCache} [options.cache] shared cache instance
   * @param {boolean} [options.throwOnError=true] abort the batch on first
   *   failure; otherwise collect errors in the result report
   */
  constructor (options = {}) {
    this.java = options.java ?? defaultJava()
    this.cache = options.cache ?? new HookCache()
    this.throwOnError = options.throwOnError !== false

    /** @type {Map<string, InstalledHook>} */
    this.installed = new Map()
  }

  /**
   * Resolve a class wrapper, using the local cache first.
   */
  useClass (className) {
    const cached = this.cache.getClass(className)
    if (cached !== undefined) {
      return cached
    }
    const wrapper = this.java.use(className)
    return this.cache.putClass(className, wrapper)
  }

  /**
   * Resolve one concrete overload, using the local cache first.
   */
  resolveMethod (className, methodName, argTypes) {
    const key = makeMethodKey(className, methodName, argTypes)
    const cached = this.cache.getMethod(key)
    if (cached !== undefined) {
      return { key, method: cached }
    }

    const classWrapper = this.useClass(className)
    const dispatcher = classWrapper[methodName]
    if (dispatcher === undefined) {
      throw new Error(className + ': no such method ' + methodName)
    }

    const method = resolveOverload(dispatcher, argTypes)
    this.cache.putMethod(key, method)
    return { key, method }
  }

  /**
   * Build the JS handler assigned to a concrete overload.  All references it
   * closes over (class wrappers, original method, extras) are resolved once
   * here, keeping the hot invocation path free of bridge lookups.
   */
  _buildHandler (method, spec) {
    if (spec.passthrough === true) {
      return passthroughHandler(method)
    }

    if (typeof spec.handler === 'function') {
      return makeInvocationHandler(method, spec.handler, spec.extras)
    }

    const { onEnter, onLeave } = spec
    return makeInvocationHandler(method, (args, ctx) => {
      if (typeof onEnter === 'function') {
        onEnter(args, ctx)
      }
      const retval = ctx.callOriginal(...args)
      if (typeof onLeave === 'function') {
        return onLeave(retval, args, ctx)
      }
      return retval
    }, spec.extras)
  }

  /**
   * Install one hook spec.  A spec with `argTypes: '*'` expands to every
   * overload of the method.  Re-installing an already hooked overload is a
   * no-op that returns the existing record, so batches stay idempotent.
   *
   * @returns {InstalledHook[]}
   */
  install (spec) {
    const { className, methodName } = spec
    const classWrapper = this.useClass(className)
    const dispatcher = classWrapper[methodName]
    if (dispatcher === undefined) {
      throw new Error(className + ': no such method ' + methodName)
    }

    const targets = spec.argTypes === '*'
      ? resolveAllOverloads(dispatcher)
      : [resolveOverload(dispatcher, spec.argTypes)]

    const records = []
    for (const method of targets) {
      const signature = signatureOf(method)
      const key = makeMethodKey(className, methodName, signature.split(','))

      const existing = this.installed.get(key)
      if (existing !== undefined) {
        records.push(existing)
        continue
      }

      const originalImpl = method.implementation
      method.implementation = this._buildHandler(method, spec)

      const record = {
        key,
        className,
        methodName,
        signature,
        method,
        originalImpl
      }
      this.installed.set(key, record)
      this.cache.putMethod(key, method)
      records.push(record)
    }

    return records
  }

  /**
   * Install many specs inside a single Java.perform() round-trip.  All class
   * and overload resolution is hoisted into one VM attachment, and a single
   * Interceptor.flush() at the end makes the patches visible atomically.
   *
   * @param {HookSpec[]} specs
   * @returns {{ installed: InstalledHook[], errors: Error[], skipped: string[] }}
   */
  installBatch (specs) {
    const installed = []
    const errors = []
    const skipped = []

    const run = () => {
      for (const spec of specs) {
        try {
          const records = this.install(spec)
          for (const record of records) {
            if (installed.some(r => r.key === record.key)) {
              skipped.push(record.key)
            } else {
              installed.push(record)
            }
          }
        } catch (e) {
          if (this.throwOnError) {
            throw e
          }
          errors.push(e)
        }
      }

      // One flush for the whole batch instead of one per mangler activation.
      if (typeof Interceptor !== 'undefined' && installed.length > 0) {
        Interceptor.flush()
      }
    }

    if (typeof this.java.perform === 'function') {
      this.java.perform(run)
    } else {
      run()
    }

    return { installed, errors, skipped }
  }

  /**
   * Revert one concrete overload to its previous implementation.
   */
  revert (key) {
    const record = this.installed.get(key)
    if (record === undefined) {
      return false
    }
    record.method.implementation = record.originalImpl
    this.installed.delete(key)
    return true
  }

  /**
   * Revert every hook installed through this manager.
   */
  revertAll () {
    const keys = Array.from(this.installed.keys())
    const run = () => {
      for (const key of keys) {
        this.revert(key)
      }
      if (typeof Interceptor !== 'undefined' && keys.length > 0) {
        Interceptor.flush()
      }
    }

    if (typeof this.java.perform === 'function') {
      this.java.perform(run)
    } else {
      run()
    }

    return keys.length
  }

  /**
   * Replace the handler of a live hook without reverting/re-patching the ART
   * method.  frida-java-bridge swaps only the NativeCallback target, which is
   * far cheaper than a full reinstall.
   */
  replaceHandler (key, spec) {
    const record = this.installed.get(key)
    if (record === undefined) {
      throw new Error('No installed hook for key: ' + key)
    }
    record.method.implementation = this._buildHandler(record.method, spec)
    return record
  }

  isStatic (method) {
    return method.type === STATIC_METHOD
  }
}
