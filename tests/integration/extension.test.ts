import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  assertConsistentTableLocking,
  assertConsistentRowLocking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
  TableLockingAssertionError,
} from '../../src/index.js'
import {
  uniqueEmail,
  setupTestEnvironment,
  cleanupTestData,
  teardownTestEnvironment,
} from '../helpers/prisma-setup.js'
import type pg from 'pg'

describe('Prisma Deadlock Detection Extension', () => {
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

  describe('basic functionality', () => {
    it('should allow normal Prisma operations', async () => {
      const user = await prisma.user.create({
        data: {
          email: uniqueEmail(),
          name: 'Test User',
        },
      })

      expect(user.id).toBeDefined()
      expect(user.name).toBe('Test User')
    })

    it('should track table locks from create operations', async () => {
      await prisma.user.create({
        data: {
          email: uniqueEmail('user1'),
          name: 'User 1',
        },
      })

      // Should not throw - no inconsistent locking yet
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })
  })

  describe('table ordering detection', () => {
    it('should detect consistent table ordering', async () => {
      // Create user outside transaction
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })

      // Transaction 1: User -> Post
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user1.id },
          data: { name: 'Updated User 1' },
        })
        await tx.post.create({
          data: {
            title: 'Post 1',
            authorId: user1.id,
          },
        })
      })

      // Create another user
      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })

      // Transaction 2: User -> Post (same order)
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user2.id },
          data: { name: 'Updated User 2' },
        })
        await tx.post.create({
          data: {
            title: 'Post 2',
            authorId: user2.id,
          },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should detect inconsistent table ordering', async () => {
      // Create user
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })

      // Transaction 1: User -> Post
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user1.id },
          data: { name: 'Updated User 1' },
        })
        await tx.post.create({
          data: {
            title: 'Post 1',
            authorId: user1.id,
          },
        })
      })

      // Create another user and post
      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })

      const post2 = await prisma.post.create({
        data: {
          title: 'Post 2',
          authorId: user2.id,
        },
      })

      // Transaction 2: Post -> User (opposite order - creates cycle)
      await prisma.$transaction(async (tx) => {
        await tx.post.update({
          where: { id: post2.id },
          data: { title: 'Updated Post 2' },
        })
        await tx.user.update({
          where: { id: user2.id },
          data: { name: 'Updated User 2' },
        })
      })

      // Should throw - inconsistent ordering
      expect(() => assertConsistentTableLocking()).toThrow(
        TableLockingAssertionError
      )
    })
  })

  describe('row ordering detection', () => {
    it('should detect consistent row ordering', async () => {
      // Create users sequentially
      const userA = await prisma.user.create({
        data: { email: uniqueEmail('a'), name: 'A' },
      })
      const userB = await prisma.user.create({
        data: { email: uniqueEmail('b'), name: 'B' },
      })
      const userC = await prisma.user.create({
        data: { email: uniqueEmail('c'), name: 'C' },
      })
      const users = [userA, userB, userC]

      // Update in ascending ID order
      await prisma.$transaction(async (tx) => {
        const sortedUsers = [...users].sort((a, b) => a.id - b.id)
        for (const user of sortedUsers) {
          await tx.user.update({
            where: { id: user.id },
            data: { name: `Updated ${user.name}` },
          })
        }
      })

      // Should not throw with strict: false
      expect(() => assertConsistentRowLocking({ strict: false })).not.toThrow()
    })
  })

  describe('assertNoDeadlockRisk', () => {
    it('should pass when no issues exist', async () => {
      await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test' },
      })

      expect(() => assertNoDeadlockRisk()).not.toThrow()
    })
  })

  describe('resetDeadlockDetection', () => {
    it('should clear all tracking state', async () => {
      // Create some state
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test' },
      })

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { name: 'Updated' },
        })
        await tx.post.create({
          data: { title: 'Post', authorId: user.id },
        })
      })

      // Reset
      resetDeadlockDetection()

      // Now create opposite order - should not throw because state was reset
      const post = await prisma.post.create({
        data: {
          title: 'New Post',
          author: {
            create: {
              email: uniqueEmail('new'),
              name: 'New User',
            },
          },
        },
      })

      await prisma.$transaction(async (tx) => {
        await tx.post.update({
          where: { id: post.id },
          data: { title: 'Updated Post' },
        })
        await tx.user.update({
          where: { id: post.authorId },
          data: { name: 'Updated Author' },
        })
      })

      // Should not throw because we reset
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })
  })

  describe('raw query tracking', () => {
    it('should track table locks from $queryRaw', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await prisma.$transaction(async (tx) => {
        // Use $queryRaw with SELECT FOR UPDATE
        await tx.$queryRaw`SELECT * FROM "User" WHERE id = ${user.id} FOR UPDATE`
        await tx.post.create({
          data: { title: 'Test Post', authorId: user.id },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should track table locks from $executeRaw', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await prisma.$transaction(async (tx) => {
        // Use $executeRaw with UPDATE
        await tx.$executeRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user.id}`
        await tx.post.create({
          data: { title: 'Test Post', authorId: user.id },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should detect inconsistent table ordering with raw queries', async () => {
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })

      // Transaction 1: User -> Post
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user1.id}`
        await tx.post.create({
          data: { title: 'Post 1', authorId: user1.id },
        })
      })

      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })
      const post2 = await prisma.post.create({
        data: { title: 'Post 2', authorId: user2.id },
      })

      // Transaction 2: Post -> User (opposite order - creates cycle)
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "Post" SET title = ${'Updated'} WHERE id = ${post2.id}`
        await tx.$queryRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user2.id}`
      })

      // Should throw - inconsistent ordering
      expect(() => assertConsistentTableLocking()).toThrow(
        TableLockingAssertionError
      )
    })

    it('should track table locks from $queryRawUnsafe', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await prisma.$transaction(async (tx) => {
        // Use $queryRawUnsafe
        await tx.$queryRawUnsafe(
          `SELECT * FROM "User" WHERE id = $1 FOR UPDATE`,
          user.id
        )
        await tx.post.create({
          data: { title: 'Test Post', authorId: user.id },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should track table locks from $executeRawUnsafe', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await prisma.$transaction(async (tx) => {
        // Use $executeRawUnsafe
        await tx.$executeRawUnsafe(
          `UPDATE "User" SET name = $1 WHERE id = $2`,
          'Updated',
          user.id
        )
        await tx.post.create({
          data: { title: 'Test Post', authorId: user.id },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should handle quoted table names in raw queries', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await prisma.$transaction(async (tx) => {
        // Quoted table name should be recognized
        await tx.$queryRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user.id}`
        await tx.post.create({
          data: { title: 'Test Post', authorId: user.id },
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })
  })

  describe('auto-commit and batch transaction tracking', () => {
    // Top-level suite shares state across tests, and the "inconsistent table
    // ordering" test taints the graph with a cycle. Isolate this block so
    // assertions only see edges from operations within each test.
    beforeEach(() => {
      resetDeadlockDetection()
    })

    afterEach(() => {
      resetDeadlockDetection()
    })

    it('should not record edges between independent auto-commit operations', async () => {
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user1.id },
          data: { name: 'Updated User 1' },
        })
        await tx.post.create({
          data: { title: 'In-Tx Post', authorId: user1.id },
        })
      })

      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })
      await prisma.post.create({
        data: { title: 'Auto-Commit Post', authorId: user2.id },
      })
      await prisma.user.create({
        data: { email: uniqueEmail('user3'), name: 'User 3' },
      })

      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should record consistent ordering in batch $transaction([...])', async () => {
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })
      const post1 = await prisma.post.create({
        data: { title: 'Post 1', authorId: user1.id },
      })

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user1.id },
          data: { name: 'Updated User 1' },
        }),
        prisma.post.update({
          where: { id: post1.id },
          data: { title: 'Updated Post 1' },
        }),
      ])

      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should detect cycles introduced by batch $transaction([...])', async () => {
      const user1 = await prisma.user.create({
        data: { email: uniqueEmail('user1'), name: 'User 1' },
      })
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user1.id },
          data: { name: 'Updated User 1' },
        })
        await tx.post.create({
          data: { title: 'Post 1', authorId: user1.id },
        })
      })

      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })
      const post2 = await prisma.post.create({
        data: { title: 'Post 2', authorId: user2.id },
      })
      await prisma.$transaction([
        prisma.post.update({
          where: { id: post2.id },
          data: { title: 'Updated Post 2' },
        }),
        prisma.user.update({
          where: { id: user2.id },
          data: { name: 'Updated User 2' },
        }),
      ])

      expect(() => assertConsistentTableLocking()).toThrow(TableLockingAssertionError)
    })
  })
})
