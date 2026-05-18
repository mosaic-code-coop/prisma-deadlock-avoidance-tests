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
