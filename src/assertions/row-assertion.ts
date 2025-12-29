import type { RowCycleInfo, RowLockingOptions, StrictMode } from '../types.js'
import type { RowLockGraphs } from '../graphs/row-graph.js'
import { formatCaller } from '../utils/caller-extractor.js'

/**
 * Error thrown when inconsistent row locking order is detected.
 */
export class RowLockingAssertionError extends Error {
  public readonly issues: RowCycleInfo[]

  constructor(issues: RowCycleInfo[]) {
    const details = issues
      .map((issue) => {
        let msg = `Table "${issue.table}": `
        if (issue.message) {
          msg += issue.message
        } else if (issue.primaryKeys.length > 0) {
          msg += `keys [${issue.primaryKeys.join(', ')}] form a cycle`
        }

        if (issue.callers.length > 0) {
          msg +=
            '\n  Callers:\n' +
            issue.callers.map((c) => `    - ${formatCaller(c)}`).join('\n')
        }

        return msg
      })
      .join('\n\n')

    const message = `Inconsistent row locking order detected!\n\n${details}`

    super(message)
    this.name = 'RowLockingAssertionError'
    this.issues = issues
  }
}

/**
 * Assert that row locking has been consistent within tables.
 *
 * @param rowGraphs The row lock graphs to check
 * @param options Options controlling which tables to check and strictness mode
 * @throws RowLockingAssertionError if violations are detected
 */
export function assertConsistentRowLocking(
  rowGraphs: RowLockGraphs,
  options: RowLockingOptions = {}
): void {
  const { tables, strict = false } = options

  // Determine which tables to check
  const tablesToCheck = tables ?? rowGraphs.getAllTables()

  const issues: RowCycleInfo[] = []

  for (const table of tablesToCheck) {
    const issue = rowGraphs.checkStrictOrdering(table, strict)
    if (issue) {
      issues.push(issue)
    }
  }

  if (issues.length > 0) {
    throw new RowLockingAssertionError(issues)
  }
}
