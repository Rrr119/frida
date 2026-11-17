/**
 * Minimal in-process simulation of frida-java-bridge semantics, enough to
 * exercise resolution, caching, batching and invocation behavior without an
 * Android device.  It also counts bridge round-trips so tests and benchmarks
 * can quantify the traffic each coding style generates.
 */

export class BridgeCounters {
  constructor () {
    this.useClassCalls = 0
    this.overloadLookups = 0
    this.implementationSets = 0
    this.implementationGets = 0
    this.performEntries = 0
    this.originalInvocations = 0
    this.dispatcherScans = 0
    this.flushCalls = 0
  }

  reset () {
    for (const key of Object.keys(this)) {
      this[key] = 0
    }
  }

  snapshot () {
    return { ...this }
  }
}

export const counters = new BridgeCounters()

function makeType (className) {
  return {
    className,
    type: 'pointer',
    isCompatible (value) {
      return value === null || typeof value === 'object' || typeof value === 'string' || typeof value === 'number'
    }
  }
}

let methodIdCounter = 0

function makeConcreteMethod (className, methodName, argTypeNames, isStatic, body) {
  const method = {
    id: ++methodIdCounter,
    methodName,
    type: isStatic ? 2 : 3,
    holder: { $n: className },
    argumentTypes: argTypeNames.map(makeType),
    returnType: makeType('void'),
    _impl: null,
    apply (receiver, args) {
      counters.originalInvocations++
      return body !== undefined ? body(...args) : undefined
    }
  }

  Object.defineProperty(method, 'implementation', {
    enumerable: true,
    get () {
      counters.implementationGets++
      return method._impl
    },
    set (fn) {
      counters.implementationSets++
      method._impl = fn
    }
  })

  return method
}

function makeDispatcher (className, methodName, variants, isStatic) {
  const overloads = variants.map(v =>
    makeConcreteMethod(className, methodName, v.argTypes, isStatic, v.body))

  const dispatcher = function () {
    // Emulate dispatcher.invoke(): linear scan of every overload.
    counters.dispatcherScans++
    for (const method of overloads) {
      if (method.argumentTypes.length === arguments.length) {
        return method.apply(this, arguments)
      }
    }
    throw new Error('no matching overload')
  }

  dispatcher.methodName = methodName
  dispatcher.overloads = overloads
  dispatcher.overload = function (...wanted) {
    counters.overloadLookups++
    const signature = wanted.join(':')
    for (const method of overloads) {
      const s = method.argumentTypes.map(t => t.className).join(':')
      if (s === signature) {
        return method
      }
    }
    throw new Error('no such overload')
  }

  Object.defineProperty(dispatcher, 'implementation', {
    enumerable: true,
    get () {
      if (overloads.length !== 1) {
        throw new Error('ambiguous')
      }
      return overloads[0].implementation
    },
    set (fn) {
      if (overloads.length !== 1) {
        throw new Error('ambiguous')
      }
      overloads[0].implementation = fn
    }
  })

  return dispatcher
}

/**
 * Build a fake Java runtime with the requested class layout.
 *
 * layout example:
 *   {
 *     'com.example.Foo': {
 *       bar: { argTypes: [['int'], ['java.lang.String', 'int']], static: false }
 *     }
 *   }
 */
export function makeFakeJava (layout) {
  const classes = new Map()

  for (const [className, members] of Object.entries(layout)) {
    const wrapper = { $n: className }
    for (const [methodName, def] of Object.entries(members)) {
      const variants = def.argTypes.map(argTypes => ({ argTypes, body: def.body }))
      wrapper[methodName] = makeDispatcher(className, methodName, variants, def.static === true)
    }
    classes.set(className, wrapper)
  }

  return {
    counters,
    use (className) {
      counters.useClassCalls++
      const wrapper = classes.get(className)
      if (wrapper === undefined) {
        throw new Error('Class not found: ' + className)
      }
      return wrapper
    },
    perform (fn) {
      counters.performEntries++
      return fn()
    }
  }
}

export const fakeInterceptor = {
  flush () {
    counters.flushCalls++
  }
}

export function installFakeGlobals (java) {
  globalThis.Java = java
  globalThis.Interceptor = fakeInterceptor
}

export function removeFakeGlobals () {
  delete globalThis.Java
  delete globalThis.Interceptor
}
