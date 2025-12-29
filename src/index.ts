// Main extension
export { withDeadlockDetection, wrapPrismaWithDeadlockDetection } from './extension.js'

// Assertion functions
export {
  assertConsistentTableLocking,
  assertConsistentRowLocking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
  trackForUpdate,
  startOperationBatch,
  endOperationBatch,
  withOperationTracking,
} from './extension.js'

// Error types
export { TableLockingAssertionError } from './assertions/table-assertion.js'
export { RowLockingAssertionError } from './assertions/row-assertion.js'

// Types
export type {
  CallerInfo,
  StrictMode,
  RowLockingOptions,
  TableCycleInfo,
  RowCycleInfo,
  DeadlockDetectionConfig,
} from './types.js'
