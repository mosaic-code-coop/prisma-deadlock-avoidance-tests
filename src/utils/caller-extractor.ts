import type { CallerInfo } from '../types.js'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'

/**
 * Get the current working directory for relative path calculation
 */
function getCwd(): string {
  // Try to get from process.cwd() first, fall back to the URL of this module
  try {
    return process.cwd()
  } catch {
    // Fallback: use this file's location
    const moduleUrl = import.meta.url
    const modulePath = fileURLToPath(moduleUrl)
    return modulePath.slice(0, modulePath.lastIndexOf('/'))
  }
}

/**
 * Make a file path relative to the current working directory if possible.
 * Returns the original path if it cannot be made relative.
 */
function makeRelativePath(filePath: string): string {
  if (filePath === 'unknown') {
    return filePath
  }

  // Don't try to make non-file paths relative
  if (filePath.startsWith('node:') || filePath.startsWith('(node:')) {
    return filePath
  }

  try {
    const cwd = getCwd()
    return relative(cwd, filePath)
  } catch {
    // If relative path calculation fails, return original
    return filePath
  }
}

/**
 * Patterns to filter out from stack traces.
 * These represent library code that should not be considered the "caller"
 */
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.prisma[\\/]client/,
  /prisma-deadlock-avoidance-tests[\\/](?:src|dist)[\\/]/,
  /prisma-select-for-update[\\/](?:src|dist)[\\/]/,
  /\(node:/,
  /^node:/,
]

/**
 * Parse a V8 stack frame line and extract location info.
 * Handles both formats:
 * - "    at functionName (file:line:column)"
 * - "    at file:line:column"
 */
function parseStackFrame(line: string): CallerInfo | null {
  // Try format: "at functionName (file:line:column)"
  const withFnMatch = line.match(/at\s+(.+?)\s+\((.+):(\d+):(\d+)\)/)
  if (withFnMatch) {
    const [, functionName, file, lineStr, columnStr] = withFnMatch
    return {
      file,
      line: parseInt(lineStr, 10),
      column: parseInt(columnStr, 10),
      functionName: functionName || undefined,
    }
  }

  // Try format: "at file:line:column"
  const withoutFnMatch = line.match(/at\s+(.+):(\d+):(\d+)/)
  if (withoutFnMatch) {
    const [, file, lineStr, columnStr] = withoutFnMatch
    return {
      file,
      line: parseInt(lineStr, 10),
      column: parseInt(columnStr, 10),
    }
  }

  return null
}

/**
 * Check if a file path should be ignored
 */
function shouldIgnore(file: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(file))
}

/**
 * Extract the first relevant caller from the current stack trace.
 * Filters out node_modules, Prisma internals, and this library's code.
 *
 * @returns CallerInfo for the first non-library caller, or a fallback if none found
 */
export function extractCaller(): CallerInfo {
  const stack = new Error().stack ?? ''
  const lines = stack.split('\n').slice(1) // Skip "Error" line

  for (const line of lines) {
    const parsed = parseStackFrame(line)
    if (!parsed) continue

    if (!shouldIgnore(parsed.file)) {
      return parsed
    }
  }

  // Fallback if no relevant frame found
  return {
    file: 'unknown',
    line: 0,
    column: 0,
  }
}

/**
 * Create a unique key for a caller based on file and line.
 * Used for deduplication in graphs.
 */
export function callerKey(caller: CallerInfo): string {
  return `${caller.file}:${caller.line}`
}

/**
 * Add a caller to an array if it's not already present (deduplicated by file:line).
 * Modifies the array in place.
 *
 * @param callers Array of callers to add to
 * @param caller Caller to add if unique
 */
export function addCallerIfUnique(callers: CallerInfo[], caller: CallerInfo): void {
  const key = callerKey(caller)
  const alreadyExists = callers.some((c) => callerKey(c) === key)
  if (!alreadyExists) {
    callers.push(caller)
  }
}

/**
 * Format a CallerInfo as a human-readable string.
 * File paths are made relative to the current working directory.
 */
export function formatCaller(caller: CallerInfo): string {
  const relativeFile = makeRelativePath(caller.file)
  const location = `${relativeFile}:${caller.line}:${caller.column}`
  if (caller.functionName) {
    return `${caller.functionName} (${location})`
  }
  return location
}
