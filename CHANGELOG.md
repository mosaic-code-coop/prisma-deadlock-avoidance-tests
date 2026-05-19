# 0.2.1 (2026-05-19)

### Bug Fixes

- **false-positive cycles between independent auto-commit operations:**
  `recordTableLock` unconditionally added a graph edge from every
  previously-recorded table to the current one, and `currentOperationTables`
  was only ever reset on `$transaction` entry/exit. As a result, two
  sequential non-transactional locking ops (e.g. `prisma.user.create()` then
  `prisma.post.create()` in a test fixture) recorded a `User → Post` edge
  even though at the DB level each statement runs in its own auto-commit
  transaction and cannot deadlock with the next. Gate edge recording on
  `state.inBatch` so only operations inside a transaction contribute to the
  graph.
- **batch-form `$transaction([...])` now tracked:** the `$transaction` proxy
  only wrapped the interactive (function) form in `withOperationTracking`,
  so batch-form transactions never flipped `inBatch=true`. They incidentally
  still produced edges via the unconditional `recordTableLock` (along with
  spurious bleed-over from adjacent statements). Now batch transactions are
  wrapped too, so their cross-table ordering is recorded as a real batch
  while auto-commit edges are dropped. The proxy also forwards all
  positional arguments, so the optional second-arg options object (e.g.
  `isolationLevel`, `timeout`) is no longer silently dropped.
- **assertions silently no-op'd under vitest/jest without parallel mode:**
  `assertConsistentTableLocking`, `assertConsistentRowLocking`, and
  `assertNoDeadlockRisk` short-circuited on `detectRunnerWorker()` whenever
  a runner env var (`VITEST_POOL_ID`, `JEST_WORKER_ID`,
  `NODE_TEST_CONTEXT`) was set, regardless of whether parallel mode was
  enabled. With vitest's `singleFork: true` (or any single-process run),
  `VITEST_POOL_ID` is still set, so the assertions returned without
  checking and cycles went undetected. Gate the worker early-return on
  `isParallelModeActive() && detectRunnerWorker()` so the worker-defers-to-
  coordinator path only fires when parallel mode is genuinely on.

# 0.2.0 (2026-05-18)

### Features

- **parallel test support:** detect deadlock cycles across multiple parallel
  test worker processes. Each worker serializes its lock-ordering graphs to a
  per-worker JSON file on `beforeExit`; a coordinator step in the test
  runner's global teardown merges every worker's file and runs the cycle
  assertions against the merged view. Catches cross-worker cycles (worker A
  locks `User`→`Post`, worker B locks `Post`→`User`) that are invisible to
  any single worker's local assertion.
- **`withDeadlockDetection` options:** new optional second argument
  `DeadlockDetectionOptions` with two fields:
  - `parallel: false | true | 'auto'` (default `false`) — enable parallel
    mode. `'auto'` enables iff a test-runner worker env var is detected
    (`VITEST_POOL_ID`, `JEST_WORKER_ID`, `NODE_TEST_CONTEXT`), so the same
    setup file is safe in single-process and parallel runs.
  - `onMissingParallelMode: 'error' | 'warn' | 'silent'` (default `'error'`)
    — what to do when the library detects it is running inside a parallel
    test worker but parallel mode is off. Default throws on the first lock
    with instructions to enable parallel mode or downgrade to a warning.
- **`assertNoDeadlockRisk` is parallel-aware:** in a worker context it is a
  silent no-op (assertion deferred to the coordinator); in coordinator
  context it merges all worker state files, asserts on the merged graph, and
  cleans up the state directory on success.

### Bug Fixes

- **graphlib import:** switch `import { Graph, alg } from '@dagrejs/graphlib'`
  to default-import + destructure (`import gl from '@dagrejs/graphlib'; const
  { Graph, alg } = gl`). The named-import form broke at runtime in Node 24+
  because `@dagrejs/graphlib` is CJS-only and Node's CJS named-export
  inference (`cjs-module-lexer`) doesn't reliably detect its
  `module.exports = { Graph, alg, ... }` shape. Fixes `SyntaxError: Named
  export 'alg' not found`.
- **type preservation through wrapper:** relax `withDeadlockDetection`'s
  generic from `<T extends PrismaClient>(client: T): T` to `<T>(client: T):
  T`. Constraining `T` to `PrismaClient` (or any structural subtype) caused
  TS to widen the inferred type to the constraint when wrapping an
  already-extended client, dropping the consumer's model methods. With the
  unconstrained generic, the wrapped client now keeps full type inference
  for `prisma.user.findMany()` etc.

# 0.1.0 (2026-05-15)
