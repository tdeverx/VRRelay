import { performance } from 'node:perf_hooks';
const url = process.argv[2];
if (!url)
  throw new Error(
    'Usage: node script/benchmark.mjs <playlist-or-segment-url> [concurrency] [requests]'
  );
const concurrency = Math.max(1, Number(process.argv[3] ?? 20));
const requests = Math.max(concurrency, Number(process.argv[4] ?? 200));
let next = 0,
  bytes = 0,
  failures = 0;
const latencies = [],
  started = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next++ < requests) {
      const before = performance.now();
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const body = await response.arrayBuffer();
        if (!response.ok) failures++;
        bytes += body.byteLength;
      } catch {
        failures++;
      }
      latencies.push(performance.now() - before);
    }
  })
);
latencies.sort((a, b) => a - b);
const elapsed = (performance.now() - started) / 1000;
const p = (value) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))];
console.log(
  JSON.stringify(
    {
      requests,
      concurrency,
      failures,
      seconds: elapsed,
      requestsPerSecond: requests / elapsed,
      mebibytesPerSecond: bytes / 1048576 / elapsed,
      latencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) }
    },
    null,
    2
  )
);
