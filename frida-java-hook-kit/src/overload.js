/**
 * Overload resolution on top of frida-java-bridge dispatchers.
 *
 * A bridge method wrapper carries an `overloads` array where every entry
 * describes its parameter types through `argumentTypes`.  The built-in
 * `dispatcher.overload(...)` performs a linear scan with signature-string
 * construction on every call; this module resolves once and lets the kit
 * cache the concrete method wrapper.
 */

export class OverloadError extends Error {
  constructor (message, available) {
    super(message)
    this.name = 'OverloadError'
    this.available = available
  }
}

function describeSignature (method) {
  return method.argumentTypes.map(t => t.className)
}

function formatAvailable (methodName, overloads) {
  return overloads.map(m => {
    const params = describeSignature(m)
    return params.length === 0
      ? '\t.' + methodName + '.overload()'
      : '\t.' + methodName + '.overload(\'' + params.join('\', \'') + '\')'
  }).join('\n')
}

function equalSignature (method, wanted) {
  const { argumentTypes } = method
  if (argumentTypes.length !== wanted.length) {
    return false
  }
  for (let i = 0; i !== wanted.length; i++) {
    if (argumentTypes[i].className !== wanted[i]) {
      return false
    }
  }
  return true
}

/**
 * Resolve one concrete method wrapper.
 *
 * @param {object} dispatcher bridge method wrapper obtained from `Class[name]`
 * @param {string[]|undefined} argTypes explicit JNI type names, or undefined
 *   when the caller wants the unique overload (and accepts an error if the
 *   name is ambiguous).
 */
export function resolveOverload (dispatcher, argTypes) {
  const { overloads } = dispatcher
  const methodName = dispatcher.methodName

  if (overloads.length === 1 && argTypes === undefined) {
    return overloads[0]
  }

  if (argTypes === undefined) {
    throw new OverloadError(
      methodName + '(): ambiguous overload, specify an argument signature:\n' +
        formatAvailable(methodName, overloads),
      overloads.map(describeSignature)
    )
  }

  for (const method of overloads) {
    if (equalSignature(method, argTypes)) {
      return method
    }
  }

  throw new OverloadError(
    methodName + '(): no overload matches (' + argTypes.join(', ') + '):\n' +
      formatAvailable(methodName, overloads),
    overloads.map(describeSignature)
  )
}

/**
 * Resolve every overload (or every overload matching a filter).  Used by the
 * batch hooker when a spec wants one handler attached to all variants of a
 * method name.
 *
 * @param {object} dispatcher bridge method wrapper
 * @param {Function} [predicate] optional filter receiving a concrete method
 */
export function resolveAllOverloads (dispatcher, predicate) {
  if (predicate === undefined) {
    return dispatcher.overloads.slice()
  }
  return dispatcher.overloads.filter(predicate)
}

/**
 * Signature string used both as a cache key and for user-facing diagnostics.
 */
export function signatureOf (method) {
  return describeSignature(method).join(',')
}
