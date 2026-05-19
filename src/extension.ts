import { Prisma } from '@prisma/client'
import type { DeadlockDetectionOptions, RowLockingOptions } from './types.js'
import { TableLockGraph } from './graphs/table-graph.js'
import { RowLockGraphs } from './graphs/row-graph.js'
import { extractCaller } from './utils/caller-extractor.js'
import { extractPrimaryKeys } from './utils/primary-key-extractor.js'
import { inferTableFromSql, isLockingSql } from './utils/raw-query-parser.js'
import {
  assertConsistentTableLocking as assertTableLocking,
  TableLockingAssertionError,
} from './assertions/table-assertion.js'
import {
  assertConsistentRowLocking as assertRowLocking,
  RowLockingAssertionError,
} from './assertions/row-assertion.js'
import {
  aggregateAndAssert,
  detectRunnerWorker,
  enableParallelMode,
  getDetectedRunnerEnv,
  isCoordinatorContext,
  isParallelModeActive,
} from './parallel.js'

/**
 * Structural type for any Prisma client (base or already-extended) that we can
 * wrap with deadlock detection. Both `$extends` and `$transaction` are
 * preserved when extensions are applied, so we accept any object that has
 * them.
 */
interface PrismaLike {
  $extends: (extension: unknown) => unknown
  $transaction: (...args: unknown[]) => unknown
}

/**
 * Operations that acquire locks on records
 */
const LOCKING_OPERATIONS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
])

/**
 * Global state singleton
 */
interface GlobalStateInstance {
  tableGraph: TableLockGraph
  rowGraphs: RowLockGraphs
  // Track table lock order per call stack (simplified transaction tracking)
  currentOperationTables: string[]
  // Track locked records per table within the current batch (for deduplication)
  // Maps table name -> Set of serialized primary keys
  currentLockedRecords: Map<string, Set<string>>
  // Whether we're inside a tracked batch (transaction)
  inBatch: boolean
}

let globalState: GlobalStateInstance | null = null

/**
 * What to do when the library detects it's running in a parallel test worker
 * but parallel mode is off. Configured via `withDeadlockDetection` options.
 */
let onMissingParallelMode: 'error' | 'warn' | 'silent' = 'error'
let missingNoticeFired = false

function fireMissingParallelModeNoticeIfNeeded(): void {
  if (missingNoticeFired) return
  if (isParallelModeActive()) return
  if (!detectRunnerWorker()) return

  missingNoticeFired = true

  if (onMissingParallelMode === 'silent') return

  const envSig = getDetectedRunnerEnv()
  const msg =
    `[prisma-deadlock-detection] Detected parallel test worker (${envSig}) but ` +
    `parallel mode is off. Cross-worker deadlock cycles will NOT be detected.\n\n` +
    `Fix: pass { parallel: 'auto' } to withDeadlockDetection().\n` +
    `To downgrade this error to a warning, use ` +
    `{ parallel: false, onMissingParallelMode: 'warn' }.`

  if (onMissingParallelMode === 'error') {
    throw new Error(msg)
  }
  console.warn(msg)
}

/**
 * Get or create the global state instance
 */
function getGlobalState(): GlobalStateInstance {
  if (!globalState) {
    globalState = {
      tableGraph: new TableLockGraph(),
      rowGraphs: new RowLockGraphs(),
      currentOperationTables: [],
      currentLockedRecords: new Map(),
      inBatch: false,
    }
  }
  return globalState
}

/**
 * Start tracking a new transaction or batch of operations.
 * Called automatically when $transaction is invoked.
 */
function startOperationBatch(): void {
  const state = getGlobalState()
  state.currentOperationTables = []
  state.currentLockedRecords.clear()
  state.inBatch = true
}

/**
 * End the current operation batch.
 * Called automatically when $transaction completes.
 */
function endOperationBatch(): void {
  const state = getGlobalState()
  state.currentOperationTables = []
  state.currentLockedRecords.clear()
  state.inBatch = false
}

/**
 * Execute a function while tracking table ordering as a single batch.
 * Called automatically by the $transaction wrapper.
 */
async function withOperationTracking<T>(fn: () => Promise<T>): Promise<T> {
  startOperationBatch()
  try {
    return await fn()
  } finally {
    endOperationBatch()
  }
}

/**
 * Record a table lock, creating edges from previously locked tables in the current batch
 */
function recordTableLock(table: string, state: GlobalStateInstance): void {
  fireMissingParallelModeNoticeIfNeeded()

  // Auto-commit operations release their locks before the next statement
  // runs, so they cannot deadlock with adjacent statements. Only record
  // edges inside a transaction batch. See REQUIREMENTS.md §1.1.
  if (!state.inBatch) return

  const caller = extractCaller()

  for (const prevTable of state.currentOperationTables) {
    if (prevTable !== table) {
      state.tableGraph.addEdge(prevTable, table, caller)
    }
  }

  if (!state.currentOperationTables.includes(table)) {
    state.currentOperationTables.push(table)
  }
}

/**
 * Record row ordering from query results.
 * Filters out records that have already been locked in the current transaction.
 */
function recordRowOrdering(
  table: string,
  result: unknown,
  state: GlobalStateInstance
): void {
  fireMissingParallelModeNoticeIfNeeded()
  const allKeys = extractPrimaryKeys(table, result)
  if (allKeys.length === 0) {
    return
  }

  // Get or create the set of locked records for this table
  let lockedRecords = state.currentLockedRecords.get(table)
  if (!lockedRecords) {
    lockedRecords = new Set()
    state.currentLockedRecords.set(table, lockedRecords)
  }

  // Filter out records that have already been locked in this transaction
  const newKeys = state.inBatch
    ? allKeys.filter((key) => !lockedRecords.has(key))
    : allKeys

  // Mark the new records as locked
  for (const key of newKeys) {
    lockedRecords.add(key)
  }

  // Only add to graph if we have multiple new keys (need ordering)
  if (newKeys.length > 1) {
    const caller = extractCaller()
    state.rowGraphs.addRowOrdering(table, newKeys, caller)
  }
}

/**
 * Extract SQL string from raw query args
 */
function extractSqlFromArgs(args: unknown): string {
  if (!args) return ''

  if (typeof args === 'object' && args !== null) {
    const argsObj = args as Record<string, unknown>
    if ('strings' in argsObj && Array.isArray(argsObj.strings)) {
      return String(argsObj.strings[0] ?? '')
    }
    if ('0' in argsObj) {
      return String(argsObj['0'] ?? '')
    }
  }

  if (typeof args === 'string') {
    return args
  }

  return ''
}

/**
 * Extract SQL from unsafe query args
 */
function extractSqlFromUnsafeArgs(args: unknown): string {
  if (Array.isArray(args) && args.length > 0) {
    return String(args[0] ?? '')
  }
  return ''
}

/**
 * Handle raw query tracking - extracts SQL, infers table, and records table lock.
 * Logs a warning if table inference fails.
 */
function handleRawQuery(
  args: unknown,
  extractFn: (args: unknown) => string,
  enabled: boolean
): void {
  if (!enabled) return

  const sql = extractFn(args)
  if (!sql) return

  const table = inferTableFromSql(sql)

  if (table && isLockingSql(sql)) {
    const state = getGlobalState()
    recordTableLock(table, state)
  } else if (isLockingSql(sql) && !table) {
    // Log warning if this is a locking query but we couldn't infer the table
    console.warn(
      `[prisma-deadlock-detection] Could not infer table name from raw query. ` +
        `The query will not be tracked for deadlock detection. ` +
        `Query: ${sql.slice(0, 100)}${sql.length > 100 ? '...' : ''}`
    )
  }
}

/**
 * Create the internal Prisma extension for query interception.
 */
function createDeadlockExtension(enabled: boolean) {
  return Prisma.defineExtension({
    name: 'prisma-deadlock-detection',

    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!enabled) {
            return query(args)
          }

          const state = getGlobalState()
          const isLocking = LOCKING_OPERATIONS.has(operation)

          // Record table lock before query execution
          if (isLocking) {
            recordTableLock(model, state)
          }

          // Execute the query
          const result = await query(args)

          // Record row ordering from result
          if (isLocking && result !== null && result !== undefined) {
            recordRowOrdering(model, result, state)
          }

          return result
        },
      },

      async $queryRaw({ args, query }) {
        handleRawQuery(args, extractSqlFromArgs, enabled)
        return query(args)
      },

      async $queryRawUnsafe({ args, query }) {
        handleRawQuery(args, extractSqlFromUnsafeArgs, enabled)
        return query(args)
      },

      async $executeRaw({ args, query }) {
        handleRawQuery(args, extractSqlFromArgs, enabled)
        return query(args)
      },

      async $executeRawUnsafe({ args, query }) {
        handleRawQuery(args, extractSqlFromUnsafeArgs, enabled)
        return query(args)
      },
    },
  })
}

/**
 * Wrap a Prisma client with deadlock detection.
 * Automatically tracks table and row locking order across all transactions.
 *
 * Usage:
 * ```typescript
 * const prisma = withDeadlockDetection(new PrismaClient())
 * ```
 *
 * @param client The PrismaClient instance to wrap
 * @param config Optional configuration
 * @returns A wrapped client with automatic transaction tracking
 */
// Unconstrained generic T: at runtime we only need `$extends` and
// `$transaction` (both preserved through any layer of Prisma extensions),
// but constraining `T` to a structural `PrismaLike` causes TS to widen the
// inferred type to that minimum, losing the consumer's model methods.
// Leaving T fully open keeps the input type intact through the wrapper.
export function withDeadlockDetection<T>(
  client: T,
  options?: DeadlockDetectionOptions
): T {
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[@mosaic-code/prisma-deadlock-avoidance-tests] WARNING: This library is intended for test environments only. ' +
        'Running in production may impact performance.'
    )
  }

  const enabled = options?.enabled !== false

  if (options?.onMissingParallelMode !== undefined) {
    onMissingParallelMode = options.onMissingParallelMode
  }

  const parallelOpt = options?.parallel
  const shouldEnableParallel =
    parallelOpt === true || (parallelOpt === 'auto' && detectRunnerWorker())

  if (shouldEnableParallel && enabled) {
    enableParallelMode(() => {
      const state = getGlobalState()
      return {
        table: state.tableGraph.toJSON(),
        rows: state.rowGraphs.toJSON(),
      }
    })
  }

  // T is fully open for caller ergonomics; internally we know we need
  // $extends and $transaction. Narrow once with `as PrismaLike`.
  const prismaLike = client as PrismaLike

  // Apply the query interception extension
  const extended = prismaLike.$extends(createDeadlockExtension(enabled)) as PrismaLike

  // Wrap with proxy to intercept $transaction calls
  return new Proxy(extended, {
    get(target: PrismaLike, prop: string | symbol) {
      if (prop === '$transaction') {
        return function (...callArgs: unknown[]) {
          const originalMethod = target.$transaction as (...a: unknown[]) => Promise<unknown>
          const firstArg = callArgs[0]
          const isInteractive = typeof firstArg === 'function'
          const isBatch = Array.isArray(firstArg)

          if ((isInteractive || isBatch) && enabled) {
            return withOperationTracking(() => originalMethod.apply(target, callArgs))
          }

          return originalMethod.apply(target, callArgs)
        }
      }

      // For all other properties, return the original value
      const value = (target as unknown as Record<string, unknown>)[String(prop)]

      // If it's a function, bind it to the target
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T
}

/**
 * Assert that table locking has been consistent across all tracked operations.
 * Throws TableLockingAssertionError if a cycle is detected.
 *
 * In parallel mode:
 * - Worker context: silent no-op (assertion deferred to coordinator).
 * - Coordinator context: merges all worker state files and asserts on the
 *   merged graph. Does NOT clean up state files (use `assertNoDeadlockRisk`
 *   to clean up after both assertions pass).
 */
export function assertConsistentTableLocking(): void {
  if (isParallelModeActive() && detectRunnerWorker()) return
  if (isCoordinatorContext()) {
    aggregateAndAssert({ tableOnly: true })
    return
  }
  const state = getGlobalState()
  assertTableLocking(state.tableGraph)
}

/**
 * Assert that row locking has been consistent within tables.
 * Throws RowLockingAssertionError if violations are detected.
 *
 * In parallel mode:
 * - Worker context: silent no-op.
 * - Coordinator context: merges all worker state files and asserts. Does NOT
 *   clean up state files.
 *
 * @param options Options controlling which tables to check and strictness mode
 */
export function assertConsistentRowLocking(options?: RowLockingOptions): void {
  if (isParallelModeActive() && detectRunnerWorker()) return
  if (isCoordinatorContext()) {
    aggregateAndAssert({ rowOnly: true, rowOptions: options })
    return
  }
  const state = getGlobalState()
  assertRowLocking(state.rowGraphs, options)
}

/**
 * Assert no deadlock risk exists by checking both table and row locking consistency.
 *
 * In parallel mode:
 * - Worker context: silent no-op.
 * - Coordinator context: merges all worker state files, asserts both table and
 *   row consistency, and deletes the state directory on success.
 *
 * @param rowOptions Options for the row locking assertion
 */
export function assertNoDeadlockRisk(rowOptions?: RowLockingOptions): void {
  if (isParallelModeActive() && detectRunnerWorker()) return
  if (isCoordinatorContext()) {
    aggregateAndAssert({ rowOptions, cleanup: true })
    return
  }
  const state = getGlobalState()
  assertTableLocking(state.tableGraph)
  assertRowLocking(state.rowGraphs, rowOptions)
}

/**
 * Reset all deadlock detection state.
 * Call this between test runs if needed.
 */
export function resetDeadlockDetection(): void {
  globalState = null
}

/**
 * Wrapper function for tracking operations from prisma-lock-for-update.
 * Use this to wrap forUpdate calls so they're tracked in the deadlock detection graph.
 *
 * @param model The model name (e.g., 'User', 'Post')
 * @param fn The async function that performs the forUpdate operation
 * @returns The result of the operation
 *
 * @example
 * ```typescript
 * const user = await trackForUpdate('User', () =>
 *   tx.user.findUniqueForUpdate({ where: { id: 1 } })
 * )
 * ```
 */
export async function trackForUpdate<T>(
  model: string,
  fn: () => Promise<T>
): Promise<T> {
  const state = getGlobalState()

  // Record the table lock
  recordTableLock(model, state)

  // Execute the operation
  const result = await fn()

  // Extract and record row ordering from result
  if (result !== null && result !== undefined) {
    recordRowOrdering(model, result, state)
  }

  return result
}

// Re-export error types for consumers
export { TableLockingAssertionError, RowLockingAssertionError }
