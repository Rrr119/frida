/**
 * On-device Frida agent: measures real ART hook overhead.
 *
 * Bundle with frida-compile, then select the mode by loading a one-line
 * prelude before the bundle (see bench/mode-naive.js and bench/mode-kit.js):
 *
 *   frida -U -f com.example.benchtarget \
 *     -l build/mode-naive.js -l build/device-benchmark.js
 *
 * The target app must contain bench/BenchTarget.java.  Results are emitted
 * with send() as {topic: 'benchmark', ...} messages.
 */

import HookManager from '../src/index.js'

const MODE = globalThis.__BENCH_MODE ?? 'kit'
const TARGET_CLASS = 'com.example.benchtarget.BenchTarget'
const ITERATIONS = 100_000

function nowMs () {
  return Date.now()
}

function measure (label, fn, iterations) {
  fn(1000) // warmup
  const start = nowMs()
  const sink = fn(iterations)
  const elapsed = nowMs() - start
  return {
    label,
    iterations,
    elapsedMs: elapsed,
    nsPerOp: (elapsed * 1e6) / iterations,
    sink
  }
}

Java.perform(() => {
  const Target = Java.use(TARGET_CLASS)

  if (MODE === 'naive') {
    // Conventional style: resolve inside the install loop and re-enter the
    // dispatcher on every invocation.
    for (const overload of Target.work.overloads) {
      const sig = overload.argumentTypes.map(t => t.className)
      const original = Target.work.overload(...sig)
      original.implementation = function (...args) {
        return original.apply(this, args)
      }
    }
  } else {
    const manager = new HookManager()
    manager.installBatch([{
      className: TARGET_CLASS,
      methodName: 'work',
      argTypes: '*',
      handler (args, ctx) {
        return ctx.callOriginal(...args)
      }
    }])
    send({ topic: 'benchmark', cache: manager.cache.stats })
  }

  const instance = Target.$new()
  const result = measure(MODE + ' hooked invocation',
    n => instance.runIterations(n), ITERATIONS)

  send({ topic: 'benchmark', mode: MODE, ...result })
})
