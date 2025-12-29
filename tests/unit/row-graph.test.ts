import { describe, it, expect, beforeEach } from 'vitest'
import { RowLockGraphs } from '../../src/graphs/row-graph.js'
import type { CallerInfo } from '../../src/types.js'

describe('RowLockGraphs', () => {
  let graphs: RowLockGraphs

  const caller1: CallerInfo = {
    file: '/app/src/service.ts',
    line: 10,
    column: 5,
    functionName: 'updateUsers',
  }

  const caller2: CallerInfo = {
    file: '/app/src/service.ts',
    line: 20,
    column: 5,
    functionName: 'updateOtherUsers',
  }

  beforeEach(() => {
    graphs = new RowLockGraphs()
  })

  describe('addRowOrdering', () => {
    it('should create edges between consecutive keys', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      const graph = graphs.getGraph('User')
      expect(graph).toBeDefined()
      expect(graph!.hasEdge('1', '2')).toBe(true)
      expect(graph!.hasEdge('2', '3')).toBe(true)
    })

    it('should not create edges for single key', () => {
      graphs.addRowOrdering('User', ['1'], caller1)

      const graph = graphs.getGraph('User')
      expect(graph).toBeUndefined()
    })

    it('should skip self-edges', () => {
      graphs.addRowOrdering('User', ['1', '1', '2'], caller1)

      const graph = graphs.getGraph('User')
      expect(graph!.hasEdge('1', '1')).toBe(false)
      expect(graph!.hasEdge('1', '2')).toBe(true)
    })

    it('should deduplicate callers by file:line', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.addRowOrdering('User', ['1', '2'], caller1)

      const graph = graphs.getGraph('User')
      const label = graph!.edge('1', '2')
      expect(label.callers).toHaveLength(1)
    })

    it('should accumulate different callers', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.addRowOrdering('User', ['1', '2'], caller2)

      const graph = graphs.getGraph('User')
      const label = graph!.edge('1', '2')
      expect(label.callers).toHaveLength(2)
    })
  })

  describe('findCycles', () => {
    it('should return empty for acyclic ordering', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      expect(graphs.findCycles('User')).toHaveLength(0)
    })

    it('should detect cycles in row ordering', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.addRowOrdering('User', ['2', '1'], caller2) // Creates cycle

      const cycles = graphs.findCycles('User')
      expect(cycles.length).toBeGreaterThan(0)
    })

    it('should return empty for non-existent table', () => {
      expect(graphs.findCycles('NonExistent')).toHaveLength(0)
    })
  })

  describe('checkAscendingOrder', () => {
    it('should return true for ascending order', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      expect(graphs.checkAscendingOrder('User')).toBe(true)
    })

    it('should return false for descending order', () => {
      graphs.addRowOrdering('User', ['3', '2', '1'], caller1)

      expect(graphs.checkAscendingOrder('User')).toBe(false)
    })

    it('should return true for empty table', () => {
      expect(graphs.checkAscendingOrder('User')).toBe(true)
    })
  })

  describe('checkDescendingOrder', () => {
    it('should return true for descending order', () => {
      graphs.addRowOrdering('User', ['3', '2', '1'], caller1)

      expect(graphs.checkDescendingOrder('User')).toBe(true)
    })

    it('should return false for ascending order', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      expect(graphs.checkDescendingOrder('User')).toBe(false)
    })
  })

  describe('checkStrictOrdering', () => {
    it('should return null for valid ascending with strict ASC', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      expect(graphs.checkStrictOrdering('User', 'ASC')).toBeNull()
    })

    it('should return issue for descending with strict ASC', () => {
      graphs.addRowOrdering('User', ['3', '2', '1'], caller1)

      const issue = graphs.checkStrictOrdering('User', 'ASC')
      expect(issue).not.toBeNull()
      expect(issue?.message).toContain('ascending')
    })

    it('should return null for valid descending with strict DESC', () => {
      graphs.addRowOrdering('User', ['3', '2', '1'], caller1)

      expect(graphs.checkStrictOrdering('User', 'DESC')).toBeNull()
    })

    it('should return issue for ascending with strict DESC', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)

      const issue = graphs.checkStrictOrdering('User', 'DESC')
      expect(issue).not.toBeNull()
      expect(issue?.message).toContain('descending')
    })

    it('should return null for consistent ordering with strict true', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)
      graphs.addRowOrdering('User', ['4', '5', '6'], caller2)

      expect(graphs.checkStrictOrdering('User', true)).toBeNull()
    })

    it('should return issue for mixed ordering with strict true', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)
      graphs.addRowOrdering('User', ['6', '5', '4'], caller2) // Descending

      const issue = graphs.checkStrictOrdering('User', true)
      expect(issue).not.toBeNull()
      expect(issue?.message).toContain('neither')
    })

    it('should return null for any order with strict false (if no cycles)', () => {
      graphs.addRowOrdering('User', ['1', '2', '3'], caller1)
      // Different ordering that doesn't create a cycle
      graphs.addRowOrdering('User', ['10', '9', '8'], caller2)

      expect(graphs.checkStrictOrdering('User', false)).toBeNull()
    })

    it('should return issue for cycles even with strict false', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.addRowOrdering('User', ['2', '1'], caller2) // Creates cycle

      const issue = graphs.checkStrictOrdering('User', false)
      expect(issue).not.toBeNull()
      expect(issue?.message).toContain('Cycle')
    })
  })

  describe('mergeFrom', () => {
    it('should merge graphs from another instance', () => {
      const other = new RowLockGraphs()
      other.addRowOrdering('Post', ['1', '2'], caller1)

      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.mergeFrom(other)

      expect(graphs.getGraph('User')).toBeDefined()
      expect(graphs.getGraph('Post')).toBeDefined()
    })
  })

  describe('getAllTables', () => {
    it('should return all tables with graphs', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.addRowOrdering('Post', ['1', '2'], caller1)

      const tables = graphs.getAllTables()
      expect(tables).toContain('User')
      expect(tables).toContain('Post')
    })
  })

  describe('reset', () => {
    it('should clear all graphs', () => {
      graphs.addRowOrdering('User', ['1', '2'], caller1)
      graphs.reset()

      expect(graphs.getAllTables()).toHaveLength(0)
    })
  })
})
