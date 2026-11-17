/**
 * Two-level cache used by the hook kit.
 *
 * Level 1: class wrappers returned by Java.use().  frida-java-bridge already
 * memoizes wrappers inside a ClassFactory, but resolving through the factory
 * still costs a property lookup plus a PENDING_USE spin check on every call.
 * Keeping our own Map avoids that traffic on hot code paths.
 *
 * Level 2: resolved overload method wrappers, keyed by
 * `<className>#<methodName>(<sig>)`.  Resolving an overload through the
 * dispatcher prototype walks every overload and rebuilds the signature string
 * on each invocation; here we pay that price exactly once.
 */

const METHOD_SEP = '#'

export function makeMethodKey (className, methodName, argTypes = []) {
  return className + METHOD_SEP + methodName + '(' + argTypes.join(',') + ')'
}

export default class HookCache {
  constructor () {
    this._classes = new Map()
    this._methods = new Map()
    this.hits = 0
    this.misses = 0
  }

  getClass (className) {
    const wrapper = this._classes.get(className)
    if (wrapper !== undefined) {
      this.hits++
    }
    return wrapper
  }

  putClass (className, wrapper) {
    this._classes.set(className, wrapper)
    this.misses++
    return wrapper
  }

  getMethod (key) {
    const method = this._methods.get(key)
    if (method !== undefined) {
      this.hits++
    }
    return method
  }

  putMethod (key, method) {
    this._methods.set(key, method)
    this.misses++
    return method
  }

  hasMethod (key) {
    return this._methods.has(key)
  }

  /**
   * Drop every cached reference.  Only safe to call after all installed hooks
   * have been reverted, otherwise hook callbacks keep running against detached
   * wrappers.
   */
  clear () {
    this._classes.clear()
    this._methods.clear()
    this.hits = 0
    this.misses = 0
  }

  get stats () {
    const total = this.hits + this.misses
    return {
      classes: this._classes.size,
      methods: this._methods.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total
    }
  }
}
