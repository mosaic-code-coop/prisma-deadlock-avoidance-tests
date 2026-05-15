# @mosaic-code/prisma-deadlock-avoidance-tests

A Prisma extension for detecting deadlock risks by tracking table and row locking order across transactions. Intended for use in test suites only.

## Purpose

Database deadlocks are a structural problem that occur when different code paths lock resources in conflicting orders. In a real application, deadlocks often emerge from the interaction between multiple unrelated parts of the codebase—each following its own locking pattern—that only reveal themselves when those paths execute concurrently under load.

This library helps ensure your codebase applies deadlock-prevention best practices before these issues become production problems. It does this by building a holistic graph of every table and row lock ordering across your entire test suite. By accumulating data from all tests, it can detect when different parts of your application would lock resources in ways that could deadlock.

**NOTE**: The library only works effectively when allowed to collect data continuously through your whole test suite. Configure it before your first test runs, check the risks its identified at the end of all tests.

The library detects two types of deadlock risk:

1. **Table ordering detection** - Identifies when different code paths lock tables in inconsistent orders
2. **Row ordering detection** - Identifies when rows within a table are locked in inconsistent orders

## Installation

```bash
npm install @mosaic-code/prisma-deadlock-avoidance-tests
```

## Quick Start

```typescript
import { PrismaClient } from '@prisma/client'
import {
  withDeadlockDetection,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
} from '@mosaic-code/prisma-deadlock-avoidance-tests'

// Wrap your Prisma client - transactions are tracked automatically
const prisma = withDeadlockDetection(new PrismaClient())

// At the start of your test run, clear any previous data
beforeAll(() => {
  resetDeadlockDetection()
})

// Your transactions are tracked automatically
await prisma.$transaction(async (tx) => {
  await tx.user.update({ where: { id: 1 }, data: { name: 'Updated' } })
  await tx.post.create({ data: { title: 'New Post', authorId: 1 } })
})

// At the end of your test suite, check for deadlock risks
afterAll(() => {
  assertNoDeadlockRisk()
})
```

## API

### Extension

#### `withDeadlockDetection(client, config?)`

Wraps a Prisma client with deadlock detection. All transactions are automatically tracked.

```typescript
const prisma = withDeadlockDetection(new PrismaClient())

// Optional: disable tracking
const prisma = withDeadlockDetection(new PrismaClient(), { enabled: false })
```

### Tracking Functions

#### `trackForUpdate(model, fn)`

Wrapper for integrating with [@mosaic-code/prisma-select-for-update](https://github.com/mosaic-code-coop/prisma-select-for-update). Use this to track SELECT FOR UPDATE operations.

```typescript
await prisma.$transaction(async (tx) => {
  const user = await trackForUpdate('User', () =>
    tx.user.findUniqueForUpdate({ where: { id: 1 } })
  )
  await tx.post.update({ where: { id: postId }, data: { ... } })
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

Clears all tracked state. Use this to start fresh when beginning a new test run (e.g., in CI or when manually re-running tests).

**Important**: Do NOT call this between test files. The library needs to accumulate data across your entire test suite to detect cross-file deadlock risks.

```typescript
beforeAll(() => {
  resetDeadlockDetection()
})
```

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

1. **Don't reset between test files** - The library needs to accumulate data across your entire test suite to detect cross-file deadlock risks. Only reset when starting a completely fresh test run (e.g., in CI or when manually re-running tests).

2. **Assert at end of suite** - Call `assertNoDeadlockRisk()` in a global `afterAll`

3. **Use with prisma-lock-for-update** - Wrap forUpdate calls with `trackForUpdate()`

## Example: Full Test Setup

```typescript
import { describe, it, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import {
  withDeadlockDetection,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
} from '@mosaic-code/prisma-deadlock-avoidance-tests'

const prisma = withDeadlockDetection(new PrismaClient())

beforeAll(() => {
  resetDeadlockDetection()
})

afterAll(() => {
  assertNoDeadlockRisk()
})

describe('User operations', () => {
  it('updates user and creates post', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: 1 }, data: { name: 'New' } })
      await tx.post.create({ data: { title: 'Post', authorId: 1 } })
    })
  })
})
```

## Requirements

- Node.js >= 18.18.0
- Prisma >= 7.0.0
- PostgreSQL (for raw query parsing)

## License

[Do No Harm](https://github.com/raisely/NoHarm)
