/**
 * Patterns to extract table names from PostgreSQL queries.
 * Handles both quoted ("TableName") and unquoted (tablename) identifiers.
 */
const TABLE_PATTERNS = [
  // SELECT ... FROM "Table" or FROM Table (including FOR UPDATE)
  /\bFROM\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/i,
  // UPDATE "Table" or UPDATE Table
  /\bUPDATE\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/i,
  // DELETE FROM "Table"
  /\bDELETE\s+FROM\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/i,
  // INSERT INTO "Table"
  /\bINSERT\s+INTO\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/i,
]

/**
 * Attempt to infer the table name from a raw SQL query.
 * This is a best-effort parser for PostgreSQL queries.
 *
 * @param sql The SQL query string
 * @returns The table name if found, or null if inference fails
 */
export function inferTableFromSql(sql: string): string | null {
  // Normalize whitespace for easier matching
  const normalized = sql.replace(/\s+/g, ' ').trim()

  for (const pattern of TABLE_PATTERNS) {
    const match = normalized.match(pattern)
    if (match) {
      // Return quoted name (match[1]) or unquoted name (match[2])
      const tableName = match[1] || match[2]
      if (tableName) {
        return tableName
      }
    }
  }

  return null
}

/**
 * Check if a SQL query contains a FOR UPDATE clause
 */
export function hasForUpdateClause(sql: string): boolean {
  return /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i.test(sql)
}

/**
 * Check if a SQL query is a locking operation (modifies data or acquires locks)
 */
export function isLockingSql(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()

  // Check for DML operations
  if (/^(UPDATE|DELETE|INSERT)\b/.test(normalized)) {
    return true
  }

  // Check for SELECT ... FOR UPDATE/SHARE
  if (hasForUpdateClause(sql)) {
    return true
  }

  return false
}
