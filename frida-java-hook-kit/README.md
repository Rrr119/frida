# frida-java-hook-kit

High-throughput batch Java hooking layer for [Frida](https://frida.re), built on
top of `frida-java-bridge`. It targets the slow paths that hurt when hooking
large methods and many overloads on Android:

- repeated `Java.use()` / `dispatcher.overload()` resolution,
- one `Interceptor.flush()` per hook,
- re-entering the overload dispatcher on every call to the original method,
- no idempotent lifecycle for large hook batches.

## Why

The vanilla pattern:

```js
Java.perform(() => {
  const C = Java.use('com.target.PaymentManager');   // resolved every time
  C.charge.overload('double').implementation = function (amount) {
    return this.charge(amount);                     // dispatcher scan per call
  };
});
```

scales poorly across dozens of classes and hundreds of overloads. The kit
resolves each class and concrete overload once, installs a whole batch inside a
single `Java.perform()` with one `Interceptor.flush()`, and gives callbacks a
pre-bound `callOriginal` that invokes the exact overload directly.

## Install

Copy `src/` into your Frida agent project (or reference the package) and bundle
with `frida-compile`, since the kit is ESM:

```bash
frida-compile agent.js -o build/agent.js -c
```

## Usage

```js
import { hookBatch } from 'frida-java-hook-kit';

Java.perform(() => {
  const { manager, installed, errors } = hookBatch([
    {
      className: 'com.target.security.SignatureVerifier',
      methodName: 'verify',
      argTypes: '*',                              // every overload
      handler(args, ctx) {
        const result = ctx.callOriginal(...args); // direct overload, no scan
        console.log('[verify]', ctx.signature, '=>', result);
        return result;
      }
    },
    {
      className: 'com.target.billing.PaymentManager',
      methodName: 'charge',
      argTypes: ['double'],                       // explicit signature
      onEnter(args, ctx) { ctx.amount = args[0]; },
      onLeave(retval) { console.log('charge =>', retval); return retval; }
    }
  ], { throwOnError: false });
});
```

## Hook spec

| Field | Description |
| --- | --- |
| `className` | Fully-qualified Java class name |
| `methodName` | Method to hook |
| `argTypes` | JNI type names (`['int','java.lang.String']`); omit for the unique overload, `'*'` for all overloads |
| `handler` | Full-control `(args, ctx) => retval`; highest precedence |
| `onEnter` / `onLeave` | Observation style; `onLeave` may replace the return value |
| `passthrough` | Install a forwarding hook (useful for baselines) |
| `extras` | Cached resources exposed on `ctx` (e.g. a `Java.use`d helper class) |

The invocation context (`ctx`) exposes:

- `callOriginal(...args)` — bound to the concrete overload, no dispatcher scan
- `method`, `methodName`, `className`, `static`
- every entry of `extras`

## Lifecycle

```js
const manager = new HookManager();
manager.installBatch(specs);
manager.replaceHandler(key, newSpec); // swap logic without re-patching ART
manager.revert(key);                  // revert one overload
manager.revertAll();                  // revert everything in one perform()
manager.cache.stats;                  // hit/miss counters
```

Installing the same overload twice is a no-op and returns the existing record,
so batches are safe to re-run.

## Overloads

- Omit `argTypes` when the method name has exactly one overload.
- Pass an explicit JNI signature otherwise; an `OverloadError` lists every
  available signature.
- Use `argTypes: '*'` to attach one handler to all overloads (each overload is
  still cached separately by its concrete signature).

## Testing & benchmarks

```bash
npm test          # 16 node:test unit tests against a simulated bridge
npm run bench     # in-process micro-benchmark (no device needed)
```

On-device measurements use `bench/device-benchmark.js` together with
`bench/BenchTarget.java`; see [docs/BENCHMARK.md](docs/BENCHMARK.md). Design
notes and the rationale behind each optimization are in
[docs/DESIGN.md](docs/DESIGN.md).

## Compatibility

- `frida-java-bridge` >= 7 (ESM bridge).
- Works on ART and Dalvik because it only uses the public wrapper surface
  (`Java.use`, `overloads`, `overload`, `implementation`).
