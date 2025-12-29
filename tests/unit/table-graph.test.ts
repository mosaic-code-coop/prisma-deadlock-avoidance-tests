import { describe, it, expect, beforeEach } from 'vitest'
import { TableLockGraph } from '../../src/graphs/table-graph.js'
import type { CallerInfo } from '../../src/types.js'

describe('TableLockGraph', () => {
  let graph: TableLockGraph

  const caller1: CallerInfo = {
    file: '/app/src/service.ts',
    line: 10,
    column: 5,
    functionName: 'updateUser',
  }

  const caller2: CallerInfo = {
    file: '/app/src/service.ts',
    line: 20,
    column: 5,
    functionName: 'updatePost',
  }

  const caller3: CallerInfo = {
    file: '/app/src/other.ts',
    line: 30,
    column: 5,
    functionName: 'deleteTask',
  }

  beforeEach(() => {
    graph = new TableLockGraph()
  })

  describe('addEdge', () => {
    it('should add an edge between two tables', () => {
      graph.addEdge('User', 'Post', caller1)

      const edge = graph.getEdge('User', 'Post')
      expect(edge).toBeDefined()
      expect(edge?.callers).toHaveLength(1)
      expect(edge?.callers[0]).toEqual(caller1)
    })

    it('should create nodes for both tables', () => {
      graph.addEdge('User', 'Post', caller1)

      const tables = graph.getTables()
      expect(tables).toContain('User')
      expect(tables).toContain('Post')
    })

    it('should deduplicate callers by file:line', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('User', 'Post', caller1) // Same caller

      const edge = graph.getEdge('User', 'Post')
      expect(edge?.callers).toHaveLength(1)
    })

    it('should accumulate different callers on same edge', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('User', 'Post', caller2) // Different caller

      const edge = graph.getEdge('User', 'Post')
      expect(edge?.callers).toHaveLength(2)
    })
  })

  describe('hasCycles', () => {
    it('should return false for acyclic graph', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'Comment', caller2)

      expect(graph.hasCycles()).toBe(false)
    })

    it('should return true for cyclic graph', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'User', caller2) // Creates cycle

      expect(graph.hasCycles()).toBe(true)
    })

    it('should detect longer cycles', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'Comment', caller2)
      graph.addEdge('Comment', 'User', caller3) // Creates cycle

      expect(graph.hasCycles()).toBe(true)
    })
  })

  describe('findCycles', () => {
    it('should return empty array for acyclic graph', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'Comment', caller2)

      expect(graph.findCycles()).toHaveLength(0)
    })

    it('should return cycles for cyclic graph', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'User', caller2)

      const cycles = graph.findCycles()
      expect(cycles.length).toBeGreaterThan(0)
    })
  })

  describe('findCyclesWithCallers', () => {
    it('should return cycle info with callers', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.addEdge('Post', 'User', caller2)

      const cycles = graph.findCyclesWithCallers()
      expect(cycles.length).toBeGreaterThan(0)

      const cycle = cycles[0]
      expect(cycle.tables).toBeDefined()
      expect(cycle.callers.length).toBeGreaterThan(0)
    })
  })

  describe('mergeFrom', () => {
    it('should merge edges from another graph', () => {
      const other = new TableLockGraph()
      other.addEdge('Task', 'User', caller3)

      graph.addEdge('User', 'Post', caller1)
      graph.mergeFrom(other)

      expect(graph.getEdge('Task', 'User')).toBeDefined()
      expect(graph.getEdge('User', 'Post')).toBeDefined()
    })

    it('should deduplicate callers when merging', () => {
      const other = new TableLockGraph()
      other.addEdge('User', 'Post', caller1)

      graph.addEdge('User', 'Post', caller1)
      graph.mergeFrom(other)

      const edge = graph.getEdge('User', 'Post')
      expect(edge?.callers).toHaveLength(1)
    })

    it('should accumulate different callers when merging', () => {
      const other = new TableLockGraph()
      other.addEdge('User', 'Post', caller2)

      graph.addEdge('User', 'Post', caller1)
      graph.mergeFrom(other)

      const edge = graph.getEdge('User', 'Post')
      expect(edge?.callers).toHaveLength(2)
    })
  })

  describe('reset', () => {
    it('should clear all data', () => {
      graph.addEdge('User', 'Post', caller1)
      graph.reset()

      expect(graph.getTables()).toHaveLength(0)
      expect(graph.getEdges()).toHaveLength(0)
    })
  })
})
