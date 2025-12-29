import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import crypto from 'node:crypto'
import {
  withDeadlockDetection,
  assertConsistentTableLocking,
  assertConsistentRowLocking,
  assertNoDeadlockRisk,
  resetDeadlockDetection,
  withOperationTracking,
  TableLockingAssertionError,
} from '../../src/index.js'

// Load environment variables
import 'dotenv/config'

const { Pool } = pg

function uniqueEmail(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`
}

describe('Prisma Deadlock Detection Extension', () => {
  let pool: pg.Pool
  let prisma: ReturnType<typeof createPrisma>

  function createPrisma() {
    const adapter = new PrismaPg(pool)
    return new PrismaClient({ adapter }).$extends(withDeadlockDetection())
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    })
    prisma = createPrisma()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pool.end()
  })

  beforeEach(async () => {
    // Clean up test data first
    await prisma.task.deleteMany()
    await prisma.post.deleteMany()
    await prisma.user.deleteMany()
    // Reset detection state AFTER cleanup so cleanup operations don't pollute the graph
    resetDeadlockDetection()
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
      await withOperationTracking(async () => {
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
      })

      // Create another user
      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })

      // Transaction 2: User -> Post (same order)
      await withOperationTracking(async () => {
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
      await withOperationTracking(async () => {
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
      await withOperationTracking(async () => {
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
      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          const sortedUsers = [...users].sort((a, b) => a.id - b.id)
          for (const user of sortedUsers) {
            await tx.user.update({
              where: { id: user.id },
              data: { name: `Updated ${user.name}` },
            })
          }
        })
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

      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { name: 'Updated' },
          })
          await tx.post.create({
            data: { title: 'Post', authorId: user.id },
          })
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

      await withOperationTracking(async () => {
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

      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          // Use $queryRaw with SELECT FOR UPDATE
          await tx.$queryRaw`SELECT * FROM "User" WHERE id = ${user.id} FOR UPDATE`
          await tx.post.create({
            data: { title: 'Test Post', authorId: user.id },
          })
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should track table locks from $executeRaw', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          // Use $executeRaw with UPDATE
          await tx.$executeRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user.id}`
          await tx.post.create({
            data: { title: 'Test Post', authorId: user.id },
          })
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
      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user1.id}`
          await tx.post.create({
            data: { title: 'Post 1', authorId: user1.id },
          })
        })
      })

      const user2 = await prisma.user.create({
        data: { email: uniqueEmail('user2'), name: 'User 2' },
      })
      const post2 = await prisma.post.create({
        data: { title: 'Post 2', authorId: user2.id },
      })

      // Transaction 2: Post -> User (opposite order - creates cycle)
      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "Post" SET title = ${'Updated'} WHERE id = ${post2.id}`
          await tx.$queryRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user2.id}`
        })
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

      await withOperationTracking(async () => {
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
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should track table locks from $executeRawUnsafe', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await withOperationTracking(async () => {
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
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })

    it('should handle quoted table names in raw queries', async () => {
      const user = await prisma.user.create({
        data: { email: uniqueEmail(), name: 'Test User' },
      })

      await withOperationTracking(async () => {
        await prisma.$transaction(async (tx) => {
          // Quoted table name should be recognized
          await tx.$queryRaw`UPDATE "User" SET name = ${'Updated'} WHERE id = ${user.id}`
          await tx.post.create({
            data: { title: 'Test Post', authorId: user.id },
          })
        })
      })

      // Should not throw - consistent ordering
      expect(() => assertConsistentTableLocking()).not.toThrow()
    })
  })
})
