import { describe, it, expect } from 'vitest'
import {
  extractCaller,
  callerKey,
  formatCaller,
} from '../../src/utils/caller-extractor.js'

describe('caller-extractor', () => {
  describe('extractCaller', () => {
    it('should extract caller info from stack trace', () => {
      const caller = extractCaller()

      // Should point to this test file
      expect(caller.file).toContain('caller-extractor.test.ts')
      expect(caller.line).toBeGreaterThan(0)
      expect(caller.column).toBeGreaterThan(0)
    })

    it('should filter out node_modules', () => {
      // The caller should not be from node_modules
      const caller = extractCaller()
      expect(caller.file).not.toContain('node_modules')
    })
  })

  describe('callerKey', () => {
    it('should create a unique key from file:line', () => {
      const caller = {
        file: '/app/src/service.ts',
        line: 42,
        column: 5,
        functionName: 'doSomething',
      }

      expect(callerKey(caller)).toBe('/app/src/service.ts:42')
    })
  })

  describe('formatCaller', () => {
    it('should format caller with function name', () => {
      const caller = {
        file: '/app/src/service.ts',
        line: 42,
        column: 5,
        functionName: 'doSomething',
      }

      const formatted = formatCaller(caller)
      // Paths are made relative to CWD, so expect a relative path pattern
      expect(formatted).toMatch(/doSomething \((.+)\/service\.ts:42:5\)/)
    })

    it('should format caller without function name', () => {
      const caller = {
        file: '/app/src/service.ts',
        line: 42,
        column: 5,
      }

      const formatted = formatCaller(caller)
      // Paths are made relative to CWD, so expect a relative path pattern
      expect(formatted).toMatch(/(.+)\/service\.ts:42:5/)
    })

    it('should handle unknown paths', () => {
      const caller = {
        file: 'unknown',
        line: 0,
        column: 0,
      }

      const formatted = formatCaller(caller)
      expect(formatted).toBe('unknown:0:0')
    })
  })
})
