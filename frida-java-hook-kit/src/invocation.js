/**
 * Helpers for hook callbacks.
 *
 * The single biggest per-invocation cost in hand-written Frida Java hooks is
 * traffic across the JS <-> native bridge:
 *
 *   - `this.method.apply(this, args)` re-enters the dispatcher, which walks
 *     every overload and re-checks argument compatibility before calling.
 *   - Looking up `Java.use(...)` inside the callback repeats class resolution
 *     on every invocation.
 *   - Eagerly materializing every JNI argument (the bridge already converts
 *     arguments for the JS handler, but user code often re-wraps them or
 *     builds throwaway arrays) adds more marshalling.
 *
 * The kit resolves the concrete original method wrapper once at install time
 * and hands the callback a bound `callOriginal` that invokes that exact
 * overload directly, skipping the dispatcher scan entirely.
 */

/**
 * Bind an already-resolved concrete overload to a receiver.
 *
 * @param {object} method a concrete method wrapper from `resolveOverload`
 * @param {object} receiver the `this` of the hooked instance method, or the
 *   class wrapper for a static method
 * @returns {Function} `(...args) => retval` targeting the original code
 */
export function bindOriginal (method, receiver) {
  return function callOriginal (...args) {
    return method.apply(receiver, args)
  }
}

/**
 * Wrap a user handler so it receives a normalized invocation context instead
 * of raw argument lists.  The wrapper itself does zero bridge work beyond the
 * argument conversion frida-java-bridge already performs; every helper it
 * exposes is a plain JS closure over cached references.
 *
 * @param {object} method concrete overload being hooked
 * @param {Function} handler user callback `(args, ctx) => retval`
 * @param {object} extras additional cached resources exposed on the context
 */
export function makeInvocationHandler (method, handler, extras = {}) {
  const isStatic = method.type === 2 // ClassFactory STATIC_METHOD

  return function invocationHandler (...args) {
    const receiver = isStatic ? method.holder : this
    const ctx = {
      method,
      methodName: method.methodName,
      className: method.holder.$n,
      static: isStatic,
      callOriginal: bindOriginal(method, receiver),
      ...extras
    }
    return handler(args, ctx)
  }
}

/**
 * Pass-through handler: forwards every call untouched.  Useful for benchmark
 * baselines and for temporarily neutralizing a hook without reverting the
 * ART method patch.
 */
export function passthroughHandler (method) {
  return makeInvocationHandler(method, (args, ctx) => ctx.callOriginal(...args))
}
