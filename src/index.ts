// Main extension
export { withDeadlockDetection } from './extension.js'

// Assertion functions
export {
  assertConsistentTableLocking,
  assertConsistentRowLocking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
  trackForUpdate,
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
  DeadlockDetectionOptions,
} from './types.js'
