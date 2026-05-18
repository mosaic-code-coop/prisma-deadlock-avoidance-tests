import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { RowLockingOptions } from './types.js'
import { TableLockGraph } from './graphs/table-graph.js'
import { RowLockGraphs } from './graphs/row-graph.js'
import { assertConsistentTableLocking as assertTableLocking } from './assertions/table-assertion.js'
import { assertConsistentRowLocking as assertRowLocking } from './assertions/row-assertion.js'

const BASE_DIR_NAME = 'prisma-deadlock-detection'
const RUNNER_ENV_VARS = ['VITEST_POOL_ID', 'JEST_WORKER_ID', 'NODE_TEST_CONTEXT'] as const
const STALE_DIR_AGE_MS = 60 * 60 * 1000

interface ParallelConfig {
  runId: string
  stateDir: string
}

interface WorkerStateSnapshot {
  table: unknown
  rows: Record<string, unknown>
}

type StateGetter = () => WorkerStateSnapshot

let activeConfig: ParallelConfig | null = null
let stateGetter: StateGetter | null = null
let hookRegistered = false

function envIsSet(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value !== ''
}

/**
 * Detect whether the current process is a worker spawned by a parallel test runner.
 */
export function detectRunnerWorker(): boolean {
  return RUNNER_ENV_VARS.some(envIsSet)
}

/**
 * Return a human-readable `NAME=value` describing the detected runner env var,
 * or null if none is set.
 */
export function getDetectedRunnerEnv(): string | null {
  for (const name of RUNNER_ENV_VARS) {
    if (envIsSet(name)) {
      return `${name}=${process.env[name]}`
    }
  }
  return null
}

function resolveRunId(): string {
  const envRunId = process.env.DEADLOCK_RUN_ID
  if (envRunId) return envRunId

  if (detectRunnerWorker()) {
    if (process.ppid === 1) {
      throw new Error(
        '[prisma-deadlock-detection] Cannot derive runId from process.ppid (it is 1, ' +
          'indicating an orphaned process). Set DEADLOCK_RUN_ID env var explicitly ' +
          'in your test runner globalSetup so workers and coordinator share an id.'
      )
    }
    return String(process.ppid)
  }
  // Coordinator (no worker env vars): use our own pid. This matches worker
  // process.ppid for fork-based pools where workers are direct children.
  return String(process.pid)
}

/**
 * Resolve the directory for a runId's state files. Exported so tests and
 * external coordinators can stat/clean the same path the library uses.
 */
export function getStateDir(runId: string): string {
  return path.join(os.tmpdir(), BASE_DIR_NAME, runId)
}

function sweepStaleSiblings(activeRunId: string): void {
  const baseDir = path.join(os.tmpdir(), BASE_DIR_NAME)
  if (!fs.existsSync(baseDir)) return
  const cutoff = Date.now() - STALE_DIR_AGE_MS
  for (const entry of fs.readdirSync(baseDir)) {
    // Never delete the active run's directory. mkdirSync does not refresh
    // mtime, so a reused runId can map onto an existing >1h-old dir we still
    // need.
    if (entry === activeRunId) continue
    const entryPath = path.join(baseDir, entry)
    try {
      const stat = fs.statSync(entryPath)
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(entryPath, { recursive: true, force: true })
      }
    } catch {
      // Race with another process; ignore.
    }
  }
}

/**
 * Enable parallel mode. Idempotent — subsequent calls return the existing config.
 * Registers a `beforeExit` hook that synchronously flushes worker state.
 */
export function enableParallelMode(getState: StateGetter): ParallelConfig {
  if (activeConfig) {
    stateGetter = getState
    return activeConfig
  }

  const runId = resolveRunId()
  const stateDir = getStateDir(runId)
  fs.mkdirSync(stateDir, { recursive: true })

  try {
    sweepStaleSiblings(runId)
  } catch {
    // Best-effort cleanup; never fail enableParallelMode on sweep error.
  }

  stateGetter = getState
  activeConfig = { runId, stateDir }

  if (!hookRegistered) {
    process.on('beforeExit', flushWorkerState)
    hookRegistered = true
  }

  return activeConfig
}

/**
 * Serialize this worker's current graph state to a unique file under stateDir.
 * Uses sync I/O so completion is guaranteed before process exit.
 */
export function flushWorkerState(): void {
  if (!activeConfig || !stateGetter) return
  const snapshot = stateGetter()
  const filename = `${process.pid}-${randomUUID()}.json`
  const filepath = path.join(activeConfig.stateDir, filename)
  try {
    fs.writeFileSync(filepath, JSON.stringify(snapshot), { flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw err
  }
}

/**
 * Returns the active parallel-mode config, or null if not enabled.
 */
export function isParallelModeActive(): ParallelConfig | null {
  return activeConfig
}

/**
 * True if a coordinator context should look at the filesystem for worker state.
 * This is the case when DEADLOCK_RUN_ID is set OR parallel mode was enabled in
 * this process (e.g. single-process tests that opted in with `parallel: true`).
 */
export function isCoordinatorContext(): boolean {
  return Boolean(process.env.DEADLOCK_RUN_ID) || activeConfig !== null
}

interface AggregateOptions {
  rowOptions?: RowLockingOptions
  tableOnly?: boolean
  rowOnly?: boolean
  cleanup?: boolean
}

/**
 * Read every worker state file, merge into one TableLockGraph + RowLockGraphs,
 * and run the existing cycle assertions. Throws if no state files are present
 * (surfaces "workers never wrote state" misuse). Cleans up stateDir on success
 * if `cleanup` is true.
 */
export function aggregateAndAssert(opts: AggregateOptions = {}): void {
  const { rowOptions, tableOnly = false, rowOnly = false, cleanup = false } = opts

  const runId = resolveRunId()
  const stateDir = getStateDir(runId)

  const entries = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'))
    : []

  if (entries.length === 0) {
    throw new Error(
      `[prisma-deadlock-detection] No parallel-mode state files found at ${stateDir}. ` +
        `Verify that workers ran withDeadlockDetection({ parallel: 'auto' }) and ` +
        `that DEADLOCK_RUN_ID is consistent across workers and coordinator.`
    )
  }

  const mergedTable = new TableLockGraph()
  const mergedRows = new RowLockGraphs()

  for (const filename of entries) {
    const content = fs.readFileSync(path.join(stateDir, filename), 'utf8')
    const data = JSON.parse(content) as WorkerStateSnapshot
    mergedTable.mergeFrom(TableLockGraph.fromJSON(data.table))
    mergedRows.mergeFrom(RowLockGraphs.fromJSON(data.rows))
  }

  // Assertions throw on cycles. If they throw, preserve stateDir for post-mortem.
  if (!rowOnly) {
    assertTableLocking(mergedTable)
  }
  if (!tableOnly) {
    assertRowLocking(mergedRows, rowOptions)
  }

  if (cleanup) {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

/**
 * Reset module-level state. Test-only.
 */
export function _resetParallelModeForTests(): void {
  if (hookRegistered) {
    process.removeListener('beforeExit', flushWorkerState)
    hookRegistered = false
  }
  activeConfig = null
  stateGetter = null
}
