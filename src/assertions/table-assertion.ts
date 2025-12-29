import type { TableCycleInfo, CallerInfo } from '../types.js'
import type { TableLockGraph } from '../graphs/table-graph.js'
import { formatCaller } from '../utils/caller-extractor.js'

/**
 * Error thrown when inconsistent table locking order is detected.
 */
export class TableLockingAssertionError extends Error {
  public readonly cycleInfo: TableCycleInfo

  constructor(cycleInfo: TableCycleInfo) {
    const cycleStr = [...cycleInfo.tables, cycleInfo.tables[0]].join(' -> ')

    const callerDetails = cycleInfo.callers
      .map((c) => `  ${c.table}: ${formatCaller(c.caller)}`)
      .join('\n')

    const message =
      `Inconsistent table locking order detected!\n\n` +
      `Cycle: ${cycleStr}\n\n` +
      `Callers involved:\n${callerDetails}`

    super(message)
    this.name = 'TableLockingAssertionError'
    this.cycleInfo = cycleInfo
  }
}

/**
 * Assert that table locking has been consistent (no cycles in the table lock graph).
 *
 * @param tableGraph The table lock graph to check
 * @throws TableLockingAssertionError if a cycle is detected
 */
export function assertConsistentTableLocking(tableGraph: TableLockGraph): void {
  const cycles = tableGraph.findCyclesWithCallers()

  if (cycles.length > 0) {
    // Report only the first cycle (as per requirements)
    throw new TableLockingAssertionError(cycles[0])
  }
}
