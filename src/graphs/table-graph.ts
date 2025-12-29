import { Graph, alg } from '@dagrejs/graphlib'
import type { CallerInfo, TableEdgeLabel, TableCycleInfo } from '../types.js'
import { callerKey } from '../utils/caller-extractor.js'

/**
 * Manages a directed graph of table lock ordering.
 * Nodes represent tables, edges represent "table A was locked before table B".
 */
export class TableLockGraph {
  private graph: Graph

  constructor() {
    this.graph = new Graph({ directed: true })
  }

  /**
   * Add an edge indicating that `from` table was locked before `to` table.
   * Deduplicates callers by file:line.
   */
  addEdge(from: string, to: string, caller: CallerInfo): void {
    // Ensure nodes exist
    if (!this.graph.hasNode(from)) {
      this.graph.setNode(from)
    }
    if (!this.graph.hasNode(to)) {
      this.graph.setNode(to)
    }

    // Get or create edge label
    const existingLabel = this.graph.edge(from, to) as
      | TableEdgeLabel
      | undefined

    if (existingLabel) {
      // Deduplicate callers by file:line
      const key = callerKey(caller)
      const alreadyExists = existingLabel.callers.some(
        (c) => callerKey(c) === key
      )
      if (!alreadyExists) {
        existingLabel.callers.push(caller)
      }
    } else {
      this.graph.setEdge(from, to, { callers: [caller] } satisfies TableEdgeLabel)
    }
  }

  /**
   * Merge edges from another graph into this one.
   * Used to merge transaction graphs into the global graph.
   */
  mergeFrom(other: TableLockGraph): void {
    for (const edge of other.graph.edges()) {
      const label = other.graph.edge(edge) as TableEdgeLabel
      for (const caller of label.callers) {
        this.addEdge(edge.v, edge.w, caller)
      }
    }
  }

  /**
   * Check if the graph has any cycles
   */
  hasCycles(): boolean {
    return !alg.isAcyclic(this.graph)
  }

  /**
   * Find all cycles in the graph
   */
  findCycles(): string[][] {
    return alg.findCycles(this.graph)
  }

  /**
   * Find cycles and build detailed cycle info including callers
   */
  findCyclesWithCallers(): TableCycleInfo[] {
    const cycles = this.findCycles()
    return cycles.map((cycle) => this.buildCycleInfo(cycle))
  }

  /**
   * Build detailed cycle info for a cycle
   */
  private buildCycleInfo(cycle: string[]): TableCycleInfo {
    const callers: Array<{ table: string; caller: CallerInfo }> = []

    // For each consecutive pair of tables in the cycle, find the edge callers
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i]
      const to = cycle[(i + 1) % cycle.length]
      const label = this.graph.edge(from, to) as TableEdgeLabel | undefined

      if (label && label.callers.length > 0) {
        // Add the first caller for this edge
        callers.push({
          table: to,
          caller: label.callers[0],
        })
      }
    }

    return {
      tables: cycle,
      callers,
    }
  }

  /**
   * Get the edge label between two tables
   */
  getEdge(from: string, to: string): TableEdgeLabel | undefined {
    return this.graph.edge(from, to) as TableEdgeLabel | undefined
  }

  /**
   * Get all tables in the graph
   */
  getTables(): string[] {
    return this.graph.nodes()
  }

  /**
   * Get all edges in the graph
   */
  getEdges(): Array<{ from: string; to: string; label: TableEdgeLabel }> {
    return this.graph.edges().map((e) => ({
      from: e.v,
      to: e.w,
      label: this.graph.edge(e) as TableEdgeLabel,
    }))
  }

  /**
   * Clear all data from the graph
   */
  reset(): void {
    this.graph = new Graph({ directed: true })
  }

  /**
   * Get the underlying graphlib Graph (for testing)
   */
  getUnderlyingGraph(): Graph {
    return this.graph
  }
}
