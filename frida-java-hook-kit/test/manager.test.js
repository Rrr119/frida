import test from 'node:test'
import assert from 'node:assert/strict'

import HookManager from '../src/manager.js'
import { OverloadError } from '../src/overload.js'
import { makeMethodKey } from '../src/cache.js'
import { makeFakeJava, counters, installFakeGlobals, removeFakeGlobals } from './fake-bridge.js'

const LAYOUT = {
  'com.example.Account': {
    deposit: {
      argTypes: [['int'], ['java.lang.String', 'int']],
      body (amountOrTag, maybeAmount) {
        return maybeAmount === undefined ? amountOrTag : maybeAmount
      }
    },
    balance: {
      argTypes: [[]],
      body () {
        return 100
      }
    }
  },
  'com.example.Audit': {
    log: {
      static: true,
      argTypes: [['java.lang.String']],
      body (tag) {
        return 'logged:' + tag
      }
    }
  }
}

function newManager () {
  counters.reset()
  const java = makeFakeJava(LAYOUT)
  return new HookManager({ java })
}

test.beforeEach(() => {
  const java = makeFakeJava(LAYOUT)
  installFakeGlobals(java)
  counters.reset()
})

test.afterEach(() => {
  removeFakeGlobals()
})

test('caches class wrappers and resolved overloads', () => {
  const manager = newManager()

  manager.resolveMethod('com.example.Account', 'deposit', ['int'])
  manager.resolveMethod('com.example.Account', 'deposit', ['int'])
  manager.resolveMethod('com.example.Account', 'balance', [])

  assert.equal(counters.useClassCalls, 1, 'Java.use called once for repeated class access')
  assert.equal(counters.overloadLookups, 0, 'kit resolves overloads without dispatcher.overload()')
  assert.equal(manager.cache.stats.classes, 1)
  assert.equal(manager.cache.stats.methods, 2)
  assert.ok(manager.cache.stats.hitRate > 0)
})

test('explicit signature resolves the correct overload', () => {
  const manager = newManager()

  const intVariant = manager.resolveMethod('com.example.Account', 'deposit', ['int']).method
  const stringVariant = manager
    .resolveMethod('com.example.Account', 'deposit', ['java.lang.String', 'int']).method

  assert.deepEqual(intVariant.argumentTypes.map(t => t.className), ['int'])
  assert.deepEqual(stringVariant.argumentTypes.map(t => t.className), ['java.lang.String', 'int'])
  assert.notEqual(intVariant, stringVariant)
})

test('unique overload resolves without a signature', () => {
  const manager = newManager()
  const { method } = manager.resolveMethod('com.example.Account', 'balance')
  assert.equal(method.methodName, 'balance')
})

test('ambiguous name without signature throws OverloadError with alternatives', () => {
  const manager = newManager()
  assert.throws(
    () => manager.resolveMethod('com.example.Account', 'deposit'),
    err => err instanceof OverloadError && err.available.length === 2
  )
})

test('unknown signature throws OverloadError', () => {
  const manager = newManager()
  assert.throws(
    () => manager.resolveMethod('com.example.Account', 'deposit', ['long']),
    err => err instanceof OverloadError
  )
})

test('argTypes "*" hooks every overload in one spec', () => {
  const manager = newManager()
  const seen = []

  manager.install({
    className: 'com.example.Account',
    methodName: 'deposit',
    argTypes: '*',
    onEnter (args) {
      seen.push(args.length)
    }
  })

  const account = manager.useClass('com.example.Account')
  account.deposit.overloads[0].implementation(42)
  account.deposit.overloads[1].implementation('tag', 7)

  assert.deepEqual(seen.sort(), [1, 2])
  assert.equal(manager.installed.size, 2)
})

test('onLeave can replace the return value', () => {
  const manager = newManager()

  manager.install({
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    onLeave (retval) {
      return retval + 1
    }
  })

  const account = manager.useClass('com.example.Account')
  const hooked = account.balance.overloads[0]
  assert.equal(hooked.implementation.call({ $h: {} }), 101)
})

test('full-control handler can skip the original method', () => {
  const manager = newManager()

  manager.install({
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    handler (_args, _ctx) {
      return 42
    }
  })

  const account = manager.useClass('com.example.Account')
  const hooked = account.balance.overloads[0]
  assert.equal(hooked.implementation.call({ $h: {} }), 42)
  assert.equal(counters.originalInvocations, 0)
})

test('callOriginal forwards to the cached concrete overload without scanning', () => {
  const manager = newManager()
  let captured

  manager.install({
    className: 'com.example.Account',
    methodName: 'deposit',
    argTypes: ['int'],
    handler (args, ctx) {
      captured = ctx
      return ctx.callOriginal(...args)
    }
  })

  const account = manager.useClass('com.example.Account')
  const hooked = account.deposit.overloads.find(m => m.argumentTypes.length === 1)
  const scansBefore = counters.dispatcherScans
  const result = hooked.implementation.call({ $h: {} }, 11)

  assert.equal(result, 11)
  assert.equal(counters.dispatcherScans, scansBefore, 'no dispatcher scan on original call')
  assert.equal(captured.methodName, 'deposit')
  assert.equal(captured.className, 'com.example.Account')
})

test('batch install uses a single perform entry and single flush', () => {
  const manager = newManager()

  const report = manager.installBatch([
    { className: 'com.example.Account', methodName: 'balance', argTypes: [], passthrough: true },
    { className: 'com.example.Audit', methodName: 'log', argTypes: ['java.lang.String'], passthrough: true }
  ])

  assert.equal(report.installed.length, 2)
  assert.equal(counters.performEntries, 1)
  assert.equal(counters.flushCalls, 1)
  assert.equal(counters.useClassCalls, 2)
})

test('re-installing the same overload is idempotent', () => {
  const manager = newManager()
  const spec = {
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    passthrough: true
  }

  const first = manager.install(spec)
  const setsAfterFirst = counters.implementationSets
  const second = manager.install(spec)

  assert.deepEqual(second, first)
  assert.equal(counters.implementationSets, setsAfterFirst, 'no re-patching on duplicate')
  assert.equal(manager.installed.size, 1)
})

test('revert restores the previous implementation', () => {
  const manager = newManager()
  const key = makeMethodKey('com.example.Account', 'balance', [])

  manager.install({
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    handler: () => 999
  })
  assert.equal(manager.installed.size, 1)

  const ok = manager.revert(key)
  assert.equal(ok, true)
  assert.equal(manager.installed.size, 0)

  const account = manager.useClass('com.example.Account')
  assert.equal(account.balance.overloads[0].implementation, null)
})

test('revertAll reverts every hook in one perform entry', () => {
  const manager = newManager()
  manager.installBatch([
    { className: 'com.example.Account', methodName: 'balance', argTypes: [], passthrough: true },
    { className: 'com.example.Audit', methodName: 'log', argTypes: ['java.lang.String'], passthrough: true }
  ])

  const count = manager.revertAll()
  assert.equal(count, 2)
  assert.equal(manager.installed.size, 0)
  assert.equal(counters.flushCalls, 2, 'one flush per batch boundary')
})

test('replaceHandler swaps logic without a new method patch record', () => {
  const manager = newManager()
  const key = makeMethodKey('com.example.Account', 'balance', [])
  manager.install({
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    handler: () => 1
  })

  manager.replaceHandler(key, {
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    handler: () => 2
  })

  const account = manager.useClass('com.example.Account')
  assert.equal(account.balance.overloads[0].implementation.call({ $h: {} }), 2)
  assert.equal(manager.installed.size, 1)
})

test('batch collects errors instead of throwing when throwOnError is false', () => {
  const manager = new HookManager({ java: globalThis.Java, throwOnError: false })

  const report = manager.installBatch([
    { className: 'com.example.Account', methodName: 'balance', argTypes: [], passthrough: true },
    { className: 'com.example.Account', methodName: 'missing', argTypes: [] },
    { className: 'com.example.Account', methodName: 'deposit', argTypes: ['double'] }
  ])

  assert.equal(report.installed.length, 1)
  assert.equal(report.errors.length, 2)
})

test('extras are cached on the invocation context', () => {
  const manager = newManager()
  const helper = { tag: 'cached' }
  let seen

  manager.install({
    className: 'com.example.Account',
    methodName: 'balance',
    argTypes: [],
    extras: { helper },
    handler (args, ctx) {
      seen = ctx.helper
      return ctx.callOriginal(...args)
    }
  })

  const account = manager.useClass('com.example.Account')
  account.balance.overloads[0].implementation.call({ $h: {} })
  assert.equal(seen, helper)
})
