import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TableLockGraph } from '../../src/graphs/table-graph.js'
import { RowLockGraphs } from '../../src/graphs/row-graph.js'
import {
  aggregateAndAssert,
  enableParallelMode,
  getStateDir,
  _resetParallelModeForTests,
} from '../../src/parallel.js'
import { TableLockingAssertionError } from '../../src/index.js'
import type { CallerInfo } from '../../src/types.js'

const caller: CallerInfo = {
  file: '/app/src/test.ts',
  line: 1,
  column: 1,
  functionName: 'testCase',
}

/**
 * Build a per-test stateDir and arrange env vars so the parallel module's
 * `resolveRunId` points at it. We treat this process as the coordinator —
 * delete any worker env vars vitest may have set, set DEADLOCK_RUN_ID to a
 * unique value, and restore on teardown.
 */
function setupTempStateDir(): {
  runId: string
  stateDir: string
  writeWorkerFile: (table: TableLockGraph, rows: RowLockGraphs) => void
} {
  const runId = `test-${randomUUID()}`
  const stateDir = getStateDir(runId)
  fs.mkdirSync(stateDir, { recursive: true })

  return {
    runId,
    stateDir,
    writeWorkerFile: (table, rows) => {
      const filepath = path.join(stateDir, `${process.pid}-${randomUUID()}.json`)
      fs.writeFileSync(
        filepath,
        JSON.stringify({ table: table.toJSON(), rows: rows.toJSON() })
      )
    },
  }
}

describe('parallel mode aggregation', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS_TO_CLEAR = ['VITEST_POOL_ID', 'JEST_WORKER_ID', 'NODE_TEST_CONTEXT']

  beforeEach(() => {
    // Treat this test process as a coordinator: clear any worker env vars
    // that vitest itself may have set.
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    savedEnv.DEADLOCK_RUN_ID = process.env.DEADLOCK_RUN_ID
    _resetParallelModeForTests()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    _resetParallelModeForTests()
  })

  it('detects a cross-worker table-locking cycle after merging files', () => {
    const ctx = setupTempStateDir()
    process.env.DEADLOCK_RUN_ID = ctx.runId

    // Worker A: locks User then Post.
    const tableA = new TableLockGraph()
    tableA.addEdge('User', 'Post', caller)
    ctx.writeWorkerFile(tableA, new RowLockGraphs())

    // Worker B: locks Post then User. By itself this is a DAG; the cycle
    // only appears once we merge both workers' graphs.
    const tableB = new TableLockGraph()
    tableB.addEdge('Post', 'User', caller)
    ctx.writeWorkerFile(tableB, new RowLockGraphs())

    expect(() => aggregateAndAssert({ cleanup: true })).toThrow(
      TableLockingAssertionError
    )

    // Failure preserves the stateDir for post-mortem.
    expect(fs.existsSync(ctx.stateDir)).toBe(true)

    fs.rmSync(ctx.stateDir, { recursive: true, force: true })
  })

  it('passes and cleans up when the merged graph has no cycles', () => {
    const ctx = setupTempStateDir()
    process.env.DEADLOCK_RUN_ID = ctx.runId

    const tableA = new TableLockGraph()
    tableA.addEdge('User', 'Post', caller)
    ctx.writeWorkerFile(tableA, new RowLockGraphs())

    const tableB = new TableLockGraph()
    tableB.addEdge('Post', 'Comment', caller)
    ctx.writeWorkerFile(tableB, new RowLockGraphs())

    expect(() => aggregateAndAssert({ cleanup: true })).not.toThrow()
    expect(fs.existsSync(ctx.stateDir)).toBe(false)
  })

  it('throws a clear error when no state files exist', () => {
    process.env.DEADLOCK_RUN_ID = `empty-${randomUUID()}`

    expect(() => aggregateAndAssert({ cleanup: true })).toThrow(
      /No parallel-mode state files found/
    )
  })

  it('round-trips row graphs through toJSON/fromJSON during merge', () => {
    const ctx = setupTempStateDir()
    process.env.DEADLOCK_RUN_ID = ctx.runId

    const rowsA = new RowLockGraphs()
    rowsA.addRowOrdering('User', ['1', '2'], caller)
    ctx.writeWorkerFile(new TableLockGraph(), rowsA)

    const rowsB = new RowLockGraphs()
    rowsB.addRowOrdering('User', ['2', '1'], caller)
    ctx.writeWorkerFile(new TableLockGraph(), rowsB)

    // Cycle in the row graph for 'User'.
    expect(() => aggregateAndAssert({ cleanup: true })).toThrow(
      /Inconsistent row locking order/
    )

    fs.rmSync(ctx.stateDir, { recursive: true, force: true })
  })
})

describe('parallel mode hook registration', () => {
  let savedRunId: string | undefined

  beforeEach(() => {
    savedRunId = process.env.DEADLOCK_RUN_ID
    _resetParallelModeForTests()
  })

  afterEach(() => {
    if (savedRunId === undefined) {
      delete process.env.DEADLOCK_RUN_ID
    } else {
      process.env.DEADLOCK_RUN_ID = savedRunId
    }
    _resetParallelModeForTests()
  })

  it('registers the beforeExit hook only once across multiple enable calls', () => {
    process.env.DEADLOCK_RUN_ID = `hook-test-${randomUUID()}`
    const initialCount = process.listeners('beforeExit').length

    const getter = () => ({ table: new TableLockGraph().toJSON(), rows: {} })
    enableParallelMode(getter)
    enableParallelMode(getter)
    enableParallelMode(getter)

    const afterCount = process.listeners('beforeExit').length
    expect(afterCount - initialCount).toBe(1)
  })
})
