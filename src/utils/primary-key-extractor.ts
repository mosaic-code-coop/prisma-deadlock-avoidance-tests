import { Prisma } from '@prisma/client'
import type { ModelMeta, ModelField } from '../types.js'

/**
 * Get model metadata from Prisma DMMF
 */
export function getModelMeta(modelName: string): ModelMeta | null {
  const dmmf = Prisma.dmmf
  const model = dmmf.datamodel.models.find(
    (m) => m.name.toLowerCase() === modelName.toLowerCase()
  )

  if (!model) {
    return null
  }

  return {
    name: model.name,
    dbName: model.dbName ?? null,
    fields: model.fields.map((f) => ({
      name: f.name,
      kind: f.kind as 'scalar' | 'object' | 'enum' | 'unsupported',
      type: f.type,
      dbName: f.dbName ?? null,
      isId: f.isId ?? false,
      isUnique: f.isUnique ?? false,
    })),
  }
}

/**
 * Get the primary key field(s) for a model
 */
export function getPrimaryKeyFields(model: ModelMeta): ModelField[] {
  return model.fields.filter((f) => f.isId)
}

/**
 * Extract primary key value from a single result object
 */
export function extractPrimaryKey(
  model: ModelMeta,
  result: Record<string, unknown>
): string | null {
  const pkFields = getPrimaryKeyFields(model)

  if (pkFields.length === 0) {
    return null
  }

  if (pkFields.length === 1) {
    // Single primary key
    const field = pkFields[0]
    const value = result[field.name]
    if (value !== undefined && value !== null) {
      return String(value)
    }
    return null
  }

  // Composite primary key - serialize as JSON
  const pkValues: Record<string, unknown> = {}
  for (const field of pkFields) {
    const value = result[field.name]
    if (value === undefined || value === null) {
      return null
    }
    pkValues[field.name] = value
  }

  return JSON.stringify(pkValues)
}

/**
 * Extract primary keys from query results (array or single object)
 */
export function extractPrimaryKeys(
  modelName: string,
  result: unknown
): string[] {
  const model = getModelMeta(modelName)
  if (!model) {
    return []
  }

  const keys: string[] = []

  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object') {
        const pk = extractPrimaryKey(model, item as Record<string, unknown>)
        if (pk !== null) {
          keys.push(pk)
        }
      }
    }
  } else if (result && typeof result === 'object') {
    const pk = extractPrimaryKey(model, result as Record<string, unknown>)
    if (pk !== null) {
      keys.push(pk)
    }
  }

  return keys
}

/**
 * Extract primary keys from a raw result, handling both model field names
 * and database column names
 */
export function extractPrimaryKeysFromRaw(
  modelName: string,
  results: Record<string, unknown>[]
): string[] {
  const model = getModelMeta(modelName)
  if (!model) {
    return []
  }

  const pkFields = getPrimaryKeyFields(model)
  if (pkFields.length === 0) {
    return []
  }

  const keys: string[] = []

  for (const result of results) {
    if (pkFields.length === 1) {
      const field = pkFields[0]
      // Try model field name first, then db column name
      const value =
        result[field.name] ?? (field.dbName ? result[field.dbName] : undefined)
      if (value !== undefined && value !== null) {
        keys.push(String(value))
      }
    } else {
      // Composite key
      const pkValues: Record<string, unknown> = {}
      let allFound = true

      for (const field of pkFields) {
        const value =
          result[field.name] ??
          (field.dbName ? result[field.dbName] : undefined)
        if (value === undefined || value === null) {
          allFound = false
          break
        }
        pkValues[field.name] = value
      }

      if (allFound) {
        keys.push(JSON.stringify(pkValues))
      }
    }
  }

  return keys
}
