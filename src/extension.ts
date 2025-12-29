import { Prisma, PrismaClient } from '@prisma/client'
import type { DeadlockDetectionConfig, RowLockingOptions } from './types.js'
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
 * Call this at the start of a $transaction block to properly track table ordering.
 */
export function startOperationBatch(): void {
  const state = getGlobalState()
  state.currentOperationTables = []
  state.currentLockedRecords.clear()
  state.inBatch = true
}

/**
 * End the current operation batch.
 * Call this at the end of a $transaction block.
 */
export function endOperationBatch(): void {
  const state = getGlobalState()
  state.currentOperationTables = []
  state.currentLockedRecords.clear()
  state.inBatch = false
}

/**
 * Execute a function while tracking table ordering as a single batch.
 * This is useful for wrapping $transaction calls to properly track table order.
 * Automatically called by the $transaction override for interactive transactions.
 *
 * @example
 * ```typescript
 * await withOperationTracking(async () => {
 *   await prisma.$transaction(async (tx) => {
 *     await tx.user.update({ ... })
 *     await tx.post.create({ ... })
 *   })
 * })
 * ```
 */
export async function withOperationTracking<T>(fn: () => Promise<T>): Promise<T> {
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
  const caller = extractCaller()

  // Create edges from all previously locked tables to this one
  for (const prevTable of state.currentOperationTables) {
    if (prevTable !== table) {
      state.tableGraph.addEdge(prevTable, table, caller)
    }
  }

  // Add this table to the current operation's locked tables
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
 * Create the Prisma extension for deadlock detection.
 *
 * Usage:
 * ```typescript
 * const prisma = new PrismaClient().$extends(withDeadlockDetection())
 * ```
 */
export function withDeadlockDetection(config?: DeadlockDetectionConfig) {
  const enabled = config?.enabled !== false

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
 * Wrap a Prisma client to automatically track interactive transactions.
 * This creates a Proxy that intercepts $transaction calls and wraps them
 * with operation tracking.
 *
 * Usage:
 * ```typescript
 * const prisma = wrapPrismaWithDeadlockDetection(
 *   new PrismaClient().$extends(withDeadlockDetection())
 * )
 * ```
 */
export function wrapPrismaWithDeadlockDetection<T extends PrismaClient>(
  client: T
): T {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') {
        // Return a wrapped $transaction method
        return function (args: unknown) {
          const originalMethod = target.$transaction as (args: unknown) => Promise<unknown>

          // Check if this is an interactive transaction (callback-based)
          const isInteractive = typeof args === 'function'

          if (isInteractive) {
            // Automatically wrap the transaction callback with tracking
            return withOperationTracking(() => originalMethod.call(target, args))
          }

          // Batch transaction or raw transaction - pass through
          return originalMethod.call(target, args)
        }
      }

      // For all other properties, return the original value
      const value = (target as Record<string, unknown>)[String(prop)]

      // If it's a function, bind it to the target
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Assert that table locking has been consistent across all tracked operations.
 * Throws TableLockingAssertionError if a cycle is detected.
 */
export function assertConsistentTableLocking(): void {
  const state = getGlobalState()
  assertTableLocking(state.tableGraph)
}

/**
 * Assert that row locking has been consistent within tables.
 * Throws RowLockingAssertionError if violations are detected.
 *
 * @param options Options controlling which tables to check and strictness mode
 */
export function assertConsistentRowLocking(options?: RowLockingOptions): void {
  const state = getGlobalState()
  assertRowLocking(state.rowGraphs, options)
}

/**
 * Assert no deadlock risk exists by checking both table and row locking consistency.
 * This is a convenience function that calls both assertions.
 *
 * @param rowOptions Options for the row locking assertion
 */
export function assertNoDeadlockRisk(rowOptions?: RowLockingOptions): void {
  assertConsistentTableLocking()
  assertConsistentRowLocking(rowOptions)
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
  const caller = extractCaller()

  // Create edges from all previously locked tables to this one
  for (const prevTable of state.currentOperationTables) {
    if (prevTable !== model) {
      state.tableGraph.addEdge(prevTable, model, caller)
    }
  }

  // Add this table to the current operation's locked tables
  if (!state.currentOperationTables.includes(model)) {
    state.currentOperationTables.push(model)
  }

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
