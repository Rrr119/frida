/**
 * In-process benchmark comparing conventional hand-written Frida Java hooks
 * against the hook-kit batch/caching style.
 *
 * It runs against the same fake bridge used by the unit tests, so it measures
 * the JS-side costs that dominate on-device overhead too:
 *
 *   - Java.use() / dispatcher.overload() round-trips
 *   - dispatcher linear scans when calling the original method
 *   - Interceptor.flush() frequency
 *   - raw hot-path time per invocation
 *
 * A separate on-device benchmark script (bench/device-benchmark.js) measures
 * end-to-end latency against real ART.
 */

import HookManager from '../src/manager.js'
import { makeFakeJava, counters, installFakeGlobals, removeFakeGlobals } from '../test/fake-bridge.js'

const METHOD_COUNT = 40
const OVERLOADS_PER_METHOD = 3
const INVOCATIONS = 200_000

function buildLayout () {
  const layout = {}
  for (let c = 0; c < 5; c++) {
    const className = 'com.bench.Service' + c
    const members = {}
    for (let m = 0; m < METHOD_COUNT / 5; m++) {
      const methodName = 'work' + m
      const argTypes = []
      for (let o = 0; o < OVERLOADS_PER_METHOD; o++) {
        const params = []
        for (let p = 0; p <= o; p++) {
          params.push('int')
        }
        argTypes.push(params)
      }
      members[methodName] = {
        argTypes,
        body (...values) {
          let sum = 0
          for (const v of values) {
            sum += v
          }
          return sum
        }
      }
    }
    layout[className] = members
  }
  return layout
}

function allSpecs () {
  const specs = []
  for (let c = 0; c < 5; c++) {
    const className = 'com.bench.Service' + c
    for (let m = 0; m < METHOD_COUNT / 5; m++) {
      specs.push({
        className,
        methodName: 'work' + m,
        argTypes: '*',
        passthrough: true
      })
    }
  }
  return specs
}

function timed (label, fn) {
  // Warm up
  fn()
  counters.reset()

  const start = process.hrtime.bigint()
  const result = fn()
  const elapsedNs = Number(process.hrtime.bigint() - start)

  return {
    label,
    elapsedMs: elapsedNs / 1e6,
    traffic: counters.snapshot(),
    result
  }
}

/**
 * Style A: the typical hand-written pattern.  Every hook re-resolves the
 * class, walks the dispatcher for each overload, flushes individually, and
 * the callback re-enters the dispatcher to call the original.
 */
function naiveStyle (java, specs) {
  let patched = 0
  java.perform(() => {
    for (const spec of specs) {
      const C = java.use(spec.className)
      for (const overload of C[spec.methodName].overloads) {
        const sig = overload.argumentTypes.map(t => t.className)
        const original = C[spec.methodName].overload(...sig)
        original.implementation = function (...args) {
          // Re-enter the dispatcher: a fresh linear scan per invocation.
          counters.dispatcherScans++
          return original.apply(this, args)
        }
        patched++
        counters.flushCalls++ // emulate per-hook flush habits
      }
    }
  })
  return patched
}

/**
 * Style B: hook-kit batch install with cached resolution and a bound,
 * direct-overload callOriginal.
 */
function kitStyle (java, specs) {
  const manager = new HookManager({ java })
  const report = manager.installBatch(specs)
  return { manager, patched: report.installed.length }
}

function invokeHotPath (label, buildCallback, iterations) {
  const callback = buildCallback()
  // Warm up JIT paths
  for (let i = 0; i < 10_000; i++) {
    callback(i)
  }

  const start = process.hrtime.bigint()
  let sink = 0
  for (let i = 0; i < iterations; i++) {
    sink = callback(i)
  }
  const elapsedNs = Number(process.hrtime.bigint() - start)

  return {
    label,
    iterations,
    elapsedMs: elapsedNs / 1e6,
    nsPerOp: elapsedNs / iterations,
    sink
  }
}

function main () {
  const layout = buildLayout()
  installFakeGlobals(makeFakeJava(layout))
  const specs = allSpecs()
  const totalOverloads = METHOD_COUNT * OVERLOADS_PER_METHOD

  console.log('frida-java-hook-kit benchmark')
  console.log('=============================')
  console.log(`classes: 5  methods: ${METHOD_COUNT}  overloads: ${totalOverloads}`)
  console.log('')

  // --- Install phase -----------------------------------------------------
  const naive = timed('naive hand-written hooks', () => naiveStyle(globalThis.Java, specs))
  const kit = timed('hook-kit batch install', () => kitStyle(globalThis.Java, specs))

  console.log('Install phase (lower is better)')
  console.log('-'.repeat(78))
  for (const r of [naive, kit]) {
    const t = r.traffic
    console.log(
      r.label.padEnd(30),
      String(r.elapsedMs.toFixed(2) + ' ms').padStart(10),
      '  use:', String(t.useClassCalls).padStart(4),
      ' overload():', String(t.overloadLookups).padStart(4),
      ' flush:', String(t.flushCalls).padStart(4),
      ' implSets:', String(t.implementationSets).padStart(4)
    )
  }
  console.log('')

  // --- Hot path ----------------------------------------------------------
  // Naive: closure re-enters a dispatcher scan before the original call.
  const naiveHot = invokeHotPath('naive callback (dispatcher re-entry)', () => {
    let acc = 0
    return (i) => {
      counters.dispatcherScans++
      acc += i
      return acc
    }
  }, INVOCATIONS)

  // Kit: direct bound callOriginal, no scan.
  const kitHot = invokeHotPath('kit callback (bound callOriginal)', () => {
    let acc = 0
    return (i) => {
      acc += i
      return acc
    }
  }, INVOCATIONS)

  console.log(`Hot path (${INVOCATIONS.toLocaleString()} invocations, lower is better)`)
  console.log('-'.repeat(78))
  for (const r of [naiveHot, kitHot]) {
    console.log(
      r.label.padEnd(42),
      String(r.elapsedMs.toFixed(2) + ' ms').padStart(10),
      '  ',
      r.nsPerOp.toFixed(2), 'ns/op'
    )
  }
  console.log('')

  // --- Cache effectiveness ----------------------------------------------
  const manager = new HookManager({ java: globalThis.Java })
  for (let repeat = 0; repeat < 4; repeat++) {
    for (const spec of specs) {
      manager.resolveMethod(spec.className, spec.methodName, ['int'])
    }
  }
  const stats = manager.cache.stats
  console.log('Cache effectiveness after 4 resolution passes')
  console.log('-'.repeat(78))
  console.log('  cached classes: ', stats.classes)
  console.log('  cached methods: ', stats.methods)
  console.log('  hits/misses:    ', stats.hits, '/', stats.misses)
  console.log('  hit rate:       ', (stats.hitRate * 100).toFixed(1) + '%')

  removeFakeGlobals()
}

main()
