package com.example.benchtarget;

/**
 * Minimal Android-side target for bench/device-benchmark.js.
 *
 * Build into any debuggable app, or paste the class into an existing app's
 * source set.  The harness invokes runIterations() on the main thread; each
 * iteration calls the hooked work() overload so the measured time includes a
 * full ART -> NativeCallback -> JS -> original round-trip.
 */
public class BenchTarget {

    public int work(int a) {
        return a + 1;
    }

    public int work(int a, int b) {
        return a + b;
    }

    public int work(String tag, int a) {
        return tag.length() + a;
    }

    public long runIterations(int iterations) {
        long sink = 0;
        for (int i = 0; i < iterations; i++) {
            sink += work(i);
            sink += work(i, i);
            sink += work("x", i);
        }
        return sink;
    }
}
