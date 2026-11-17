# Design

This document explains where Frida Java-hook time goes and how each piece of
the kit removes it. It is written against `frida-java-bridge` 7.x; relevant
internals live in `lib/class-factory.js` and `lib/android.js`.

## Cost model

Hooking a Java method has two distinct cost phases.

### 1. Install phase

Setting `method.implementation = fn` in the bridge (`class-factory.js`,
`methodPrototype.implementation`) triggers:

1. `implement()` — allocates a `NativeCallback` wrapping the JS handler.
2. `makeMethodMangler(methodId)` — on ART, `ArtMethodMangler.replace()` clones
   the target `ArtMethod`, patches `jniCode`/`accessFlags`/`quickCode`, and may
   install an `ArtQuickCodeInterceptor` trampoline.
3. Registration in the runtime's replaced-method table.

Around that, user scripts typically pay additional JS-side costs:

- `Java.use(className)` — factory lookup with a `PENDING_USE` spin check.
- `dispatcher.overload(...)` — linear scan over `overloads`, rebuilding the
  signature string on every call (`dispatcherPrototype.overload`).
- `Interceptor.flush()` — often called after every individual hook.

### 2. Invocation phase

Each time ART enters a hooked method:

1. ART calls the replacement `NativeCallback`.
2. `handleMethodInvocation()` constructs an `Env`, links the thread VM, pushes
   a JNI local frame, and converts every JNI argument through `type.fromJni`.
3. The user JS handler runs.
4. Return values flow back through `type.toJni`, frames pop, the thread unlinks.

Steps 1, 2 and 4 are intrinsic to the bridge and cannot be removed from user
code. The controllable cost is step 3 plus anything *around* the call:

- `this.foo.apply(this, args)` re-enters `dispatcherPrototype.invoke`, which
  re-scans every overload and re-runs `canInvokeWith` compatibility checks.
- Re-resolving classes (`Java.use`) or helpers inside the callback repeats
  bridge work on every invocation.

## Optimizations

### Batch hooking and caching

`HookManager` keeps a two-level `HookCache`:

- class wrappers keyed by class name,
- concrete method wrappers keyed by
  `className#methodName(paramType,...)`.

`installBatch(specs)` runs all resolution and patching inside one
`Java.perform()` attachment and calls `Interceptor.flush()` exactly once at the
end. Re-installing an existing key is an idempotent no-op.

### Fewer JS round-trips

- Overload resolution happens once per concrete method; the wrapper is cached,
  so `dispatcher.overload()` never runs on a hot path.
- `bindOriginal(method, receiver)` produces a closure that calls
  `method.apply(receiver, args)` on the already-resolved concrete overload,
  skipping the dispatcher scan entirely.
- Helper classes passed via `extras` are resolved once at install time and
  read from a plain property on the invocation context.
- One `Java.perform` and one flush per batch instead of per hook.

### Overload support

`overload.js` mirrors the bridge's own matching rules (arity plus
`argumentTypes[].className` equality):

- unique name + no signature → direct resolution,
- ambiguous name without signature → `OverloadError` enumerating alternatives,
- explicit signature → exact match,
- `argTypes: '*'` → expand to every overload, each cached independently.

### Hot handler swap

`replaceHandler(key, spec)` only reassigns `method.implementation`. The bridge
reverts the previous `NativeCallback` and installs a new one while leaving the
ART method patch and trampoline in place — cheaper than a full reinstall and
handy for live-tuning a running session.

## What the kit deliberately does not do

- It does not modify bridge internals or patch `ArtMethod` itself; everything
  goes through the supported wrapper API, so upgrades to frida-java-bridge do
  not break the kit.
- It does not change argument marshalling (`fromJni`/`toJni` remains the
  bridge's responsibility); doing so would require private API access and would
  be version-specific.
- It does not batch `NativeCallback` allocation — each overload still needs its
  own callback because ART binds one replacement per `ArtMethod`.

## Module layout

| Module | Responsibility |
| --- | --- |
| `src/cache.js` | Two-level class/method cache with hit statistics |
| `src/overload.js` | Signature matching, `'*'` expansion, `OverloadError` |
| `src/invocation.js` | Bound `callOriginal`, handler/context construction |
| `src/manager.js` | `HookManager`: install, batch, revert, hot swap |
| `src/index.js` | Public exports and `hookBatch` convenience entry |
| `test/fake-bridge.js` | Bridge simulation with round-trip counters |
| `bench/run.js` | In-process benchmark over the simulated bridge |
| `bench/device-benchmark.js` | On-device ART benchmark agent |
