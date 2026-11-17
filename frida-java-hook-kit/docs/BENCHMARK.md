# Benchmarks

The kit ships two complementary benchmarks.

## 1. In-process micro-benchmark

No Android device required. It drives a simulated frida-java-bridge
(`test/fake-bridge.js`) that counts bridge round-trips, so the numbers isolate
JS-side costs: class resolution, `overload()` lookups, dispatcher scans and
flushes.

```bash
npm run bench
```

Reference run (Node 22, 5 classes, 40 methods, 120 overloads, 200k hot-path
iterations):

```
Install phase (lower is better)
naive hand-written hooks          0.73 ms   use:   40  overload():  120  flush:  120  implSets:  120
hook-kit batch install            0.31 ms   use:    5  overload():    0  flush:    1  implSets:  120

Hot path (200,000 invocations, lower is better)
naive callback (dispatcher re-entry)          2.67 ms    13.36 ns/op
kit callback (bound callOriginal)             2.08 ms    10.41 ns/op

Cache effectiveness after 4 resolution passes
  hit rate:        77.5%
```

How to read it:

- Install is ~2.3x faster and, more importantly, collapses 120 flushes to 1 and
  eliminates all 120 `overload()` scans. On a real device each flush and JNI
  entry costs orders of magnitude more than in this simulation.
- The hot-path delta is deliberately small in-process because the simulation
  has no JNI marshalling. On ART the avoided dispatcher scan plus cached
  references compound with every invocation (see below).
- `implSets` is identical: both styles must install one replacement per
  overload — that cost is intrinsic to ART and not something a JS layer can
  remove.

Run-to-run variance applies; use the delta in *traffic counters* (uses,
overload lookups, flushes, scans) as the stable signal, not the millisecond
figures alone.

## 2. On-device ART benchmark

Measures end-to-end latency including the real `NativeCallback` and JNI
argument conversion.

### Setup

1. Add `bench/BenchTarget.java` to a debuggable Android app
   (`com.example.benchtarget`) and install it.
2. Bundle the agent:

   ```bash
   npm install
   npx frida-compile bench/device-benchmark.js -o build/device-benchmark.js -c
   npx frida-compile bench/mode-naive.js -o build/mode-naive.js -c
   npx frida-compile bench/mode-kit.js -o build/mode-kit.js -c
   ```

3. Run each mode against the same device/app build, loading the mode prelude
   before the benchmark bundle:

   ```bash
   # naive baseline
   frida -U -f com.example.benchtarget \
     -l build/mode-naive.js -l build/device-benchmark.js

   # optimized
   frida -U -f com.example.benchtarget \
     -l build/mode-kit.js -l build/device-benchmark.js
   ```

Results arrive as `send()` messages:

```json
{ "topic": "benchmark", "mode": "kit", "iterations": 100000,
  "elapsedMs": 842, "nsPerOp": 8420 }
```

### Interpreting on-device results

- `nsPerOp` covers three hooked overloads per iteration, each a full
  ART -> NativeCallback -> JS -> original round-trip.
- Compare like-for-like builds on the same device/Android version; ART entry
  point layout varies by version and dominates absolute numbers.
- Expected wins from the kit come from: single flush, no per-callback
  `Java.use`, and direct `callOriginal` (no `dispatcher.invoke` scan).

## Adding a scenario

The micro-benchmark layout is generated in `bench/run.js#buildLayout`; adjust
`METHOD_COUNT`, `OVERLOADS_PER_METHOD` and `INVOCATIONS` to model your target
app's shape (many small methods vs few huge ones) and re-run.
