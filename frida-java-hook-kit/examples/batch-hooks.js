/**
 * Real-world batch hook example.  Compile with frida-compile:
 *
 *   frida-compile examples/batch-hooks.js -o build/batch-hooks.js -c
 *   frida -U -f com.target.app -l build/batch-hooks.js
 */

import { hookBatch } from '../src/index.js'

Java.perform(() => {
  const { manager, installed, errors } = hookBatch([
    {
      className: 'com.target.billing.PaymentManager',
      methodName: 'charge',
      argTypes: ['double'],
      onEnter (args, ctx) {
        ctx.snapshotAmount = args[0]
      },
      onLeave (retval, args, ctx) {
        console.log('[charge]', ctx.snapshotAmount, '=>', retval)
        return retval
      }
    },
    {
      // One handler for every overload of verify().
      className: 'com.target.security.SignatureVerifier',
      methodName: 'verify',
      argTypes: '*',
      handler (args, ctx) {
        const result = ctx.callOriginal(...args)
        console.log('[verify]', ctx.signature, '=>', result)
        return result
      }
    },
    {
      className: 'com.target.net.ApiClient',
      methodName: 'request',
      argTypes: ['java.lang.String'],
      extras: {
        // Resolved once at install time, reused on every invocation.
        Log: Java.use('android.util.Log')
      },
      handler (args, ctx) {
        ctx.Log.i('ApiClient', 'request ' + args[0])
        return ctx.callOriginal(...args)
      }
    }
  ], { throwOnError: false })

  console.log(`installed ${installed.length} hooks, ${errors.length} errors`)
  errors.forEach(e => console.warn(e.message))

  // Hot reload: swap handler logic without re-patching ART.
  // manager.replaceHandler(installed[0].key, { ...newSpec });

  // Full teardown when the script unloads.
  Script.bindWeak?.({}, () => manager.revertAll())
})
