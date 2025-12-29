# prisma-consistent-ordering-assertions

A Prisma extension for detecting deadlock risks by tracking table and row locking order across transactions. Intended for use in test suites only.

## Purpose

Database deadlocks occur when two transactions lock resources in opposite orders. This library helps detect potential deadlock risks by:

1. **Table ordering detection** - Identifies when different code paths lock tables in inconsistent orders
2. **Row ordering detection** - Identifies when rows within a table are locked in inconsistent orders

## Installation

```bash
npm install prisma-consistent-ordering-assertions
```

## Quick Start

```typescript
import { PrismaClient } from '@prisma/client'
import {
  withDeadlockDetection,
  withOperationTracking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
} from 'prisma-consistent-ordering-assertions'

// Extend your Prisma client
const prisma = new PrismaClient().$extends(withDeadlockDetection())

// In your tests, wrap transactions to track table ordering
await withOperationTracking(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: 1 }, data: { name: 'Updated' } })
    await tx.post.create({ data: { title: 'New Post', authorId: 1 } })
  })
})

// At the end of your test suite, check for deadlock risks
afterAll(() => {
  assertNoDeadlockRisk()
})

// Reset between test files if needed
beforeEach(() => {
  resetDeadlockDetection()
})
```

## API

### Extension

#### `withDeadlockDetection(config?)`

Creates a Prisma extension that tracks locking operations.

```typescript
const prisma = new PrismaClient().$extends(withDeadlockDetection())

// Optional: disable tracking
const prisma = new PrismaClient().$extends(withDeadlockDetection({ enabled: false }))
```

### Tracking Functions

#### `withOperationTracking(fn)`

Wraps a function (typically containing a `$transaction`) to track table lock ordering within it.

```typescript
await withOperationTracking(async () => {
  await prisma.$transaction(async (tx) => {
    // Operations here are tracked for table ordering
    await tx.user.update({ ... })
    await tx.post.create({ ... })
  })
})
```

#### `trackForUpdate(model, fn)`

Wrapper for integrating with [prisma-lock-for-update](https://github.com/mosaic-sunrise/prisma-select-for-update). Use this to track SELECT FOR UPDATE operations.

```typescript
await withOperationTracking(async () => {
  await prisma.$transaction(async (tx) => {
    const user = await trackForUpdate('User', () =>
      tx.user.findUniqueForUpdate({ where: { id: 1 } })
    )
    await tx.post.update({ where: { id: postId }, data: { ... } })
  })
})
```

### Assertion Functions

#### `assertConsistentTableLocking()`

Checks that tables have been locked in a consistent order across all tracked transactions. Throws `TableLockingAssertionError` if a cycle is detected.

```typescript
assertConsistentTableLocking()
// Throws if Transaction A locks User->Post but Transaction B locks Post->User
```

#### `assertConsistentRowLocking(options?)`

Checks that rows within tables have been locked in a consistent order. Throws `RowLockingAssertionError` if violations are detected.

Options:
- `tables?: string[]` - Specific tables to check (defaults to all)
- `strict?: StrictMode` - Ordering strictness

StrictMode values:
- `false` (default) - Only cycles are violations
- `true` - Must be consistently ascending OR descending
- `'ASC'` - Must always be ascending order
- `'DESC'` - Must always be descending order

```typescript
// Only check for cycles
assertConsistentRowLocking({ strict: false })

// Require consistent ordering direction
assertConsistentRowLocking({ strict: true })

// Require specific ordering
assertConsistentRowLocking({ tables: ['User'], strict: 'ASC' })
```

#### `assertNoDeadlockRisk(rowOptions?)`

Convenience function that calls both `assertConsistentTableLocking()` and `assertConsistentRowLocking()`.

```typescript
assertNoDeadlockRisk()
assertNoDeadlockRisk({ strict: 'ASC' })
```

### Utility Functions

#### `resetDeadlockDetection()`

Clears all tracked state. Call this between test runs if needed.

```typescript
beforeEach(() => {
  resetDeadlockDetection()
})
```

#### `startOperationBatch()` / `endOperationBatch()`

Low-level functions for manually controlling operation batch boundaries. Prefer `withOperationTracking()` instead.

## Error Types

### `TableLockingAssertionError`

Thrown when inconsistent table locking order is detected.

```typescript
try {
  assertConsistentTableLocking()
} catch (error) {
  if (error instanceof TableLockingAssertionError) {
    console.log(error.cycleInfo.tables)  // ['User', 'Post']
    console.log(error.cycleInfo.callers) // Caller locations
  }
}
```

### `RowLockingAssertionError`

Thrown when inconsistent row locking order is detected.

```typescript
try {
  assertConsistentRowLocking({ strict: 'ASC' })
} catch (error) {
  if (error instanceof RowLockingAssertionError) {
    console.log(error.issues) // Array of violations by table
  }
}
```

## How It Works

### Table Ordering

The library builds a directed graph of table lock ordering:
- Each node is a table name
- Each edge represents "Table A was locked before Table B" within a transaction
- A cycle in this graph indicates potential deadlock risk

### Row Ordering

For each table, a separate directed graph tracks row lock ordering:
- Each node is a primary key value
- Edges represent the order rows were locked within operations
- Cycles indicate potential deadlock risk
- Strict mode can enforce ascending/descending order

### What Gets Tracked

Locking operations tracked:
- `create`, `createMany`, `createManyAndReturn`
- `update`, `updateMany`
- `delete`, `deleteMany`
- `upsert`
- Raw queries (best-effort table inference from SQL)
- `trackForUpdate()` calls

## Best Practices

1. **Reset between test files** - Call `resetDeadlockDetection()` in `beforeEach` or `beforeAll`

2. **Wrap all transactions** - Use `withOperationTracking()` around every `$transaction` call

3. **Assert at end of suite** - Call `assertNoDeadlockRisk()` in a global `afterAll`

4. **Use with prisma-lock-for-update** - Wrap forUpdate calls with `trackForUpdate()`

## Example: Full Test Setup

```typescript
import { describe, it, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import {
  withDeadlockDetection,
  withOperationTracking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
} from 'prisma-consistent-ordering-assertions'

const prisma = new PrismaClient().$extends(withDeadlockDetection())

beforeEach(() => {
  resetDeadlockDetection()
})

afterAll(() => {
  assertNoDeadlockRisk()
})

describe('User operations', () => {
  it('updates user and creates post', async () => {
    await withOperationTracking(async () => {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: 1 }, data: { name: 'New' } })
        await tx.post.create({ data: { title: 'Post', authorId: 1 } })
      })
    })
  })
})
```

## Requirements

- Node.js >= 18.18.0
- Prisma >= 7.0.0
- PostgreSQL (for raw query parsing)

## License

MIT
