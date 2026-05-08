import { Graph, alg } from '@dagrejs/graphlib'
import type { CallerInfo, RowEdgeLabel, RowCycleInfo, StrictMode } from '../types.js'
import { addCallerIfUnique, callerKey } from '../utils/caller-extractor.js'

/**
 * Manages directed graphs of row lock ordering, one per table.
 * Nodes represent primary keys, edges represent "row A was locked before row B".
 */
export class RowLockGraphs {
  private graphs: Map<string, Graph> = new Map()

  /**
   * Get or create the graph for a specific table
   */
  private getOrCreateGraph(table: string): Graph {
    let graph = this.graphs.get(table)
    if (!graph) {
      graph = new Graph({ directed: true })
      this.graphs.set(table, graph)
    }
    return graph
  }

  /**
   * Add row ordering edges for a sequence of locked rows.
   * Creates edges between consecutive rows: [a, b, c] -> a->b, b->c
   */
  addRowOrdering(
    table: string,
    orderedKeys: string[],
    caller: CallerInfo
  ): void {
    if (orderedKeys.length < 2) {
      // Need at least 2 rows to create an ordering edge
      return
    }

    const graph = this.getOrCreateGraph(table)

    // Create edges between consecutive rows
    for (let i = 0; i < orderedKeys.length - 1; i++) {
      const from = orderedKeys[i]
      const to = orderedKeys[i + 1]

      // Skip self-edges (shouldn't happen with unique PKs, but be safe)
      if (from === to) continue

      // Ensure nodes exist
      if (!graph.hasNode(from)) {
        graph.setNode(from)
      }
      if (!graph.hasNode(to)) {
        graph.setNode(to)
      }

      // Get or create edge label
      const existingLabel = graph.edge(from, to) as RowEdgeLabel | undefined

      if (existingLabel) {
        // Deduplicate callers by file:line
        addCallerIfUnique(existingLabel.callers, caller)
      } else {
        graph.setEdge(from, to, {
          callers: [caller],
          table,
        } satisfies RowEdgeLabel)
      }
    }
  }

  /**
   * Merge row graphs from another instance into this one
   */
  mergeFrom(other: RowLockGraphs): void {
    for (const [table, otherGraph] of other.graphs) {
      for (const edge of otherGraph.edges()) {
        const label = otherGraph.edge(edge) as RowEdgeLabel
        for (const caller of label.callers) {
          this.addRowOrdering(table, [edge.v, edge.w], caller)
        }
      }
    }
  }

  /**
   * Find cycles in a specific table's row graph
   */
  findCycles(table: string): string[][] {
    const graph = this.graphs.get(table)
    if (!graph) return []
    return alg.findCycles(graph)
  }

  /**
   * Check if all edges in a table's graph follow the specified ordering direction.
   * Only makes sense for numeric/comparable primary keys.
   */
  private checkOrdering(table: string, direction: 'ASC' | 'DESC'): boolean {
    const graph = this.graphs.get(table)
    if (!graph) return true

    for (const edge of graph.edges()) {
      // Try to compare as numbers
      const fromNum = Number(edge.v)
      const toNum = Number(edge.w)

      if (!isNaN(fromNum) && !isNaN(toNum)) {
        if (direction === 'ASC' && fromNum > toNum) {
          return false
        }
        if (direction === 'DESC' && fromNum < toNum) {
          return false
        }
      } else {
        // String comparison
        if (direction === 'ASC' && edge.v > edge.w) {
          return false
        }
        if (direction === 'DESC' && edge.v < edge.w) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Check if all edges in a table's graph follow ascending order.
   * Only makes sense for numeric/comparable primary keys.
   */
  checkAscendingOrder(table: string): boolean {
    return this.checkOrdering(table, 'ASC')
  }

  /**
   * Check if all edges in a table's graph follow descending order.
   */
  checkDescendingOrder(table: string): boolean {
    return this.checkOrdering(table, 'DESC')
  }

  /**
   * Check if a table's graph satisfies the given strict mode
   */
  checkStrictOrdering(table: string, mode: StrictMode): RowCycleInfo | null {
    const cycles = this.findCycles(table)

    // Cycles are always a violation
    if (cycles.length > 0) {
      const graph = this.graphs.get(table)!
      const cycle = cycles[0]
      const callers: CallerInfo[] = []

      // Collect callers from cycle edges
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i]
        const to = cycle[(i + 1) % cycle.length]
        const label = graph.edge(from, to) as RowEdgeLabel | undefined
        if (label) {
          callers.push(...label.callers)
        }
      }

      return {
        table,
        primaryKeys: cycle.map((k) => (isNaN(Number(k)) ? k : Number(k))),
        callers,
        message: `Cycle detected in row ordering`,
      }
    }

    // No strict ordering required
    if (mode === false) {
      return null
    }

    // Check specific ordering
    if (mode === 'ASC') {
      if (!this.checkAscendingOrder(table)) {
        return {
          table,
          primaryKeys: [],
          callers: this.getAllCallers(table),
          message: `Row ordering is not consistently ascending`,
        }
      }
    } else if (mode === 'DESC') {
      if (!this.checkDescendingOrder(table)) {
        return {
          table,
          primaryKeys: [],
          callers: this.getAllCallers(table),
          message: `Row ordering is not consistently descending`,
        }
      }
    } else if (mode === true) {
      // Must be either all ASC or all DESC
      const isAsc = this.checkAscendingOrder(table)
      const isDesc = this.checkDescendingOrder(table)

      if (!isAsc && !isDesc) {
        return {
          table,
          primaryKeys: [],
          callers: this.getAllCallers(table),
          message: `Row ordering is neither consistently ascending nor descending`,
        }
      }
    }

    return null
  }

  /**
   * Get all callers from a table's graph
   */
  private getAllCallers(table: string): CallerInfo[] {
    const graph = this.graphs.get(table)
    if (!graph) return []

    const callers: CallerInfo[] = []
    const seen = new Set<string>()

    for (const edge of graph.edges()) {
      const label = graph.edge(edge) as RowEdgeLabel
      for (const caller of label.callers) {
        const key = callerKey(caller)
        if (!seen.has(key)) {
          seen.add(key)
          callers.push(caller)
        }
      }
    }

    return callers
  }

  /**
   * Get all tables that have row graphs
   */
  getAllTables(): string[] {
    return Array.from(this.graphs.keys())
  }

  /**
   * Get the graph for a specific table (for testing)
   */
  getGraph(table: string): Graph | undefined {
    return this.graphs.get(table)
  }

  /**
   * Clear all data from all graphs
   */
  reset(): void {
    this.graphs.clear()
  }
}
