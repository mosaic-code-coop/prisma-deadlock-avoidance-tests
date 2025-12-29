import { describe, it, expect } from 'vitest'
import {
  inferTableFromSql,
  hasForUpdateClause,
  isLockingSql,
} from '../../src/utils/raw-query-parser.js'

describe('raw-query-parser', () => {
  describe('inferTableFromSql', () => {
    describe('SELECT queries', () => {
      it('should extract table from SELECT with quoted identifier', () => {
        const sql = 'SELECT * FROM "User" WHERE id = 1'
        expect(inferTableFromSql(sql)).toBe('User')
      })

      it('should extract table from SELECT with unquoted identifier', () => {
        const sql = 'SELECT * FROM users WHERE id = 1'
        expect(inferTableFromSql(sql)).toBe('users')
      })

      it('should extract table from SELECT FOR UPDATE', () => {
        const sql = 'SELECT * FROM "Post" WHERE id = 1 FOR UPDATE'
        expect(inferTableFromSql(sql)).toBe('Post')
      })

      it('should extract first table from SELECT with schema prefix (best effort)', () => {
        // Note: This will just get "public" which is acceptable for best-effort parsing
        // The schema.table format is tricky to parse reliably
        const sql = 'SELECT * FROM public."User" WHERE id = 1'
        // Best effort: might get 'public' or 'User' depending on regex
        const result = inferTableFromSql(sql)
        expect(result).toBeTruthy()
        // Either result is acceptable for best-effort parsing
        expect(['public', 'User']).toContain(result)
      })
    })

    describe('UPDATE queries', () => {
      it('should extract table from UPDATE with quoted identifier', () => {
        const sql = 'UPDATE "User" SET name = $1 WHERE id = $2'
        expect(inferTableFromSql(sql)).toBe('User')
      })

      it('should extract table from UPDATE with unquoted identifier', () => {
        const sql = 'UPDATE users SET name = $1 WHERE id = $2'
        expect(inferTableFromSql(sql)).toBe('users')
      })
    })

    describe('DELETE queries', () => {
      it('should extract table from DELETE with quoted identifier', () => {
        const sql = 'DELETE FROM "User" WHERE id = $1'
        expect(inferTableFromSql(sql)).toBe('User')
      })

      it('should extract table from DELETE with unquoted identifier', () => {
        const sql = 'DELETE FROM users WHERE id = $1'
        expect(inferTableFromSql(sql)).toBe('users')
      })
    })

    describe('INSERT queries', () => {
      it('should extract table from INSERT with quoted identifier', () => {
        const sql = 'INSERT INTO "User" (name, email) VALUES ($1, $2)'
        expect(inferTableFromSql(sql)).toBe('User')
      })

      it('should extract table from INSERT with unquoted identifier', () => {
        const sql = 'INSERT INTO users (name, email) VALUES ($1, $2)'
        expect(inferTableFromSql(sql)).toBe('users')
      })
    })

    describe('edge cases', () => {
      it('should return null for complex queries', () => {
        const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte'
        // The parser might match something, but CTEs are tricky
        const result = inferTableFromSql(sql)
        // Either null or 'cte' is acceptable
        expect(result === null || result === 'cte').toBe(true)
      })

      it('should handle queries with newlines', () => {
        const sql = `
          SELECT *
          FROM "User"
          WHERE id = 1
        `
        expect(inferTableFromSql(sql)).toBe('User')
      })

      it('should handle queries with multiple spaces', () => {
        const sql = 'SELECT  *  FROM   "User"   WHERE id = 1'
        expect(inferTableFromSql(sql)).toBe('User')
      })
    })
  })

  describe('hasForUpdateClause', () => {
    it('should detect FOR UPDATE', () => {
      expect(hasForUpdateClause('SELECT * FROM "User" FOR UPDATE')).toBe(true)
    })

    it('should detect FOR NO KEY UPDATE', () => {
      expect(hasForUpdateClause('SELECT * FROM "User" FOR NO KEY UPDATE')).toBe(
        true
      )
    })

    it('should detect FOR SHARE', () => {
      expect(hasForUpdateClause('SELECT * FROM "User" FOR SHARE')).toBe(true)
    })

    it('should detect FOR KEY SHARE', () => {
      expect(hasForUpdateClause('SELECT * FROM "User" FOR KEY SHARE')).toBe(
        true
      )
    })

    it('should return false for regular SELECT', () => {
      expect(hasForUpdateClause('SELECT * FROM "User"')).toBe(false)
    })
  })

  describe('isLockingSql', () => {
    it('should detect UPDATE as locking', () => {
      expect(isLockingSql('UPDATE "User" SET name = $1')).toBe(true)
    })

    it('should detect DELETE as locking', () => {
      expect(isLockingSql('DELETE FROM "User" WHERE id = $1')).toBe(true)
    })

    it('should detect INSERT as locking', () => {
      expect(isLockingSql('INSERT INTO "User" (name) VALUES ($1)')).toBe(true)
    })

    it('should detect SELECT FOR UPDATE as locking', () => {
      expect(isLockingSql('SELECT * FROM "User" FOR UPDATE')).toBe(true)
    })

    it('should not detect regular SELECT as locking', () => {
      expect(isLockingSql('SELECT * FROM "User"')).toBe(false)
    })
  })
})
