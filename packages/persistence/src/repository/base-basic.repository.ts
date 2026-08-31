import type { BaseWriteDao } from '../dao/base-write.dao.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

/**
 * Repository for non-aggregate entities (no domain events, no aggregate
 * registration). Use for simple persistence shapes without DDD tactical
 * pattern requirements.
 */
export abstract class BaseBasicRepository<TRow extends { id: string }> {
  constructor(protected readonly writeDao: BaseWriteDao<TRow>) {}

  async create(row: TRow, trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.create(row, trx);
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.createMany(rows, trx);
  }

  async update(row: TRow & { updated_at?: Date }, trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.update(row, trx);
  }

  async updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<void> {
    await this.writeDao.updateMany(rows, trx);
  }

  async delete(
    row: { id: string; updated_at?: Date | undefined },
    trx?: DatabaseTransaction,
  ): Promise<void> {
    await this.writeDao.delete(row, trx);
  }

  async deleteMany(ids: readonly string[], trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.deleteMany(ids, trx);
  }
}
