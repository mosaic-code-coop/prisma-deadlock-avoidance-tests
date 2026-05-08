import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  trackForUpdate,
  assertConsistentTableLocking,
  TableLockingAssertionError,
} from '../../src/index.js'
import {
  uniqueEmail,
  setupTestEnvironment,
  cleanupTestData,
  teardownTestEnvironment,
} from '../helpers/prisma-setup.js'
import type pg from 'pg'

describe('trackForUpdate integration', () => {
  let pool: pg.Pool
  let prisma: Awaited<ReturnType<typeof setupTestEnvironment>>['prisma']

  beforeAll(async () => {
    const env = await setupTestEnvironment()
    pool = env.pool
    prisma = env.prisma
  })

  afterAll(async () => {
    await teardownTestEnvironment(prisma, pool)
  })

  beforeEach(async () => {
    await cleanupTestData(prisma)
  })

  it('should track forUpdate operations', async () => {
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), name: 'Test' },
    })

    // Simulate using prisma-lock-for-update with trackForUpdate wrapper
    await prisma.$transaction(async (tx) => {
      // Track a "SELECT FOR UPDATE" style operation
      const lockedUser = await trackForUpdate('User', async () => {
        // In real usage, this would be tx.user.findUniqueForUpdate(...)
        return tx.user.findUnique({ where: { id: user.id } })
      })

      expect(lockedUser).toBeDefined()

      // Then update Post
      await tx.post.create({
        data: {
          title: 'New Post',
          authorId: user.id,
        },
      })
    })

    // Should not throw - consistent ordering
    expect(() => assertConsistentTableLocking()).not.toThrow()
  })

  it('should detect inconsistent ordering with trackForUpdate', async () => {
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), name: 'Test' },
    })

    const post = await prisma.post.create({
      data: { title: 'Test Post', authorId: user.id },
    })

    // Transaction 1: User -> Post
    await prisma.$transaction(async (tx) => {
      await trackForUpdate('User', async () => {
        return tx.user.findUnique({ where: { id: user.id } })
      })
      await tx.post.update({
        where: { id: post.id },
        data: { title: 'Updated' },
      })
    })

    // Transaction 2: Post -> User (opposite order)
    await prisma.$transaction(async (tx) => {
      await trackForUpdate('Post', async () => {
        return tx.post.findUnique({ where: { id: post.id } })
      })
      await tx.user.update({
        where: { id: user.id },
        data: { name: 'Updated' },
      })
    })

    // Should throw - inconsistent ordering
    expect(() => assertConsistentTableLocking()).toThrow(
      TableLockingAssertionError
    )
  })

  it('should extract primary keys from results', async () => {
    // Create users sequentially to avoid race conditions
    const userA = await prisma.user.create({
      data: { email: uniqueEmail('a'), name: 'A' },
    })
    const userB = await prisma.user.create({
      data: { email: uniqueEmail('b'), name: 'B' },
    })
    const users = [userA, userB]

    await prisma.$transaction(async (tx) => {
      // Track a findMany-style operation
      const lockedUsers = await trackForUpdate('User', async () => {
        return tx.user.findMany({
          where: { id: { in: users.map((u) => u.id) } },
          orderBy: { id: 'asc' },
        })
      })

      expect(lockedUsers).toHaveLength(2)
    })

    // Should pass - no issues
    expect(() => assertConsistentTableLocking()).not.toThrow()
  })
})
