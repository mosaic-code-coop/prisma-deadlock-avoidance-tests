import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import crypto from 'node:crypto'
import { withDeadlockDetection, resetDeadlockDetection } from '../../src/index.js'

// Load environment variables
import 'dotenv/config'

const { Pool } = pg

/**
 * Generate a unique email address for testing
 */
export function uniqueEmail(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`
}

/**
 * Setup Prisma client with deadlock detection
 */
export function createPrisma(pool: pg.Pool) {
  const adapter = new PrismaPg(pool)
  return withDeadlockDetection(new PrismaClient({ adapter }))
}

/**
 * Setup test environment: create pool and Prisma client
 */
export async function setupTestEnvironment(): Promise<{
  pool: pg.Pool
  prisma: ReturnType<typeof createPrisma>
}> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })
  const prisma = createPrisma(pool)
  return { pool, prisma }
}

/**
 * Cleanup test data and reset deadlock detection state
 */
export async function cleanupTestData(
  prisma: ReturnType<typeof createPrisma>
): Promise<void> {
  // Clean up test data first
  await prisma.task.deleteMany()
  await prisma.post.deleteMany()
  await prisma.user.deleteMany()
  // Reset detection state AFTER cleanup so cleanup operations don't pollute the graph
  resetDeadlockDetection()
}

/**
 * Teardown test environment: disconnect Prisma and close pool
 */
export async function teardownTestEnvironment(
  prisma: ReturnType<typeof createPrisma>,
  pool: pg.Pool
): Promise<void> {
  await prisma.$disconnect()
  await pool.end()
}


