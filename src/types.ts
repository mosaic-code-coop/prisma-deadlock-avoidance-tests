import type { Graph } from '@dagrejs/graphlib'

/**
 * Information about where a locking operation was called from
 */
export interface CallerInfo {
  file: string
  line: number
  column: number
  functionName?: string
}

/**
 * Operations that acquire locks on database records
 */
export type LockingOperation =
  | 'findUniqueForUpdate'
  | 'findFirstForUpdate'
  | 'findManyForUpdate'
  | 'update'
  | 'updateMany'
  | 'delete'
  | 'deleteMany'
  | 'create'
  | 'createMany'
  | 'createManyAndReturn'
  | 'upsert'
  | '$queryRaw'
  | '$queryRawUnsafe'
  | '$executeRaw'
  | '$executeRawUnsafe'

/**
 * Strict ordering modes for row locking assertions
 * - 'ASC': Primary keys must always be locked in ascending order
 * - 'DESC': Primary keys must always be locked in descending order
 * - true: Primary keys must be consistently ordered (either all ASC or all DESC)
 * - false: No ordering requirement, only cycles are violations
 */
export type StrictMode = 'ASC' | 'DESC' | true | false

/**
 * Options for assertConsistentRowLocking
 */
export interface RowLockingOptions {
  /** Specific tables to check. If empty/undefined, checks all tables. */
  tables?: string[]
  /** Ordering strictness mode. Defaults to false. */
  strict?: StrictMode
}

/**
 * Information about a cycle detected in table locking order
 */
export interface TableCycleInfo {
  /** Tables involved in the cycle, in order */
  tables: string[]
  /** Callers that contributed to the cycle */
  callers: Array<{
    table: string
    caller: CallerInfo
  }>
}

/**
 * Information about a cycle or ordering violation in row locking
 */
export interface RowCycleInfo {
  /** The table where the violation occurred */
  table: string
  /** Primary keys involved in the cycle/violation */
  primaryKeys: Array<string | number>
  /** Callers that contributed to the issue */
  callers: CallerInfo[]
  /** Optional message describing the violation */
  message?: string
}

/**
 * Label stored on table graph edges
 */
export interface TableEdgeLabel {
  /** All callers that created this edge (deduplicated by file:line) */
  callers: CallerInfo[]
}

/**
 * Label stored on row graph edges
 */
export interface RowEdgeLabel {
  /** All callers that created this edge */
  callers: CallerInfo[]
  /** The table this edge belongs to */
  table: string
}

/**
 * Configuration options for the deadlock detection extension
 */
export interface DeadlockDetectionConfig {
  /** Whether detection is enabled. Defaults to true. */
  enabled?: boolean
}

/**
 * Model metadata from Prisma DMMF
 */
export interface ModelMeta {
  name: string
  dbName: string | null
  fields: ModelField[]
}

/**
 * Field metadata from Prisma DMMF
 */
export interface ModelField {
  name: string
  kind: 'scalar' | 'object' | 'enum' | 'unsupported'
  type: string
  dbName: string | null
  isId: boolean
  isUnique: boolean
}
