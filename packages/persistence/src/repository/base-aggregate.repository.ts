import type { AggregateRoot } from '@quilla-be-kit/ddd';
import type { BaseWriteDao } from '../dao/base-write.dao.js';
import type { UnitOfWorkContext } from '../unit-of-work/unit-of-work-context.type.js';
import type { PersistenceMapper } from './mapper.interface.js';

/**
 * Base repository for aggregates. Handles persistence through a mapper and
 * registers aggregates in the `UnitOfWorkContext` so the UoW can drain
 * their domain events into the outbox at commit.
 *
 * Verb: `loadById` / `loadForUpdate...` — returns `TAggregate` (DDD
 * language). Persistence I/O delegates to `BaseWriteDao`'s `find*` methods.
 */
export abstract class BaseAggregateRepository<
  TAggregate extends AggregateRoot<object> & { id: string },
  TRow extends { id: string },
> {
  constructor(
    protected readonly mapper: PersistenceMapper<TAggregate, TRow>,
    protected readonly writeDao: BaseWriteDao<TRow>,
  ) {}

  async create(aggregate: TAggregate, ctx: UnitOfWorkContext): Promise<void> {
    await this.writeDao.create(this.mapper.toPersistence(aggregate), ctx.trx);
    ctx.registerAggregate(aggregate);
  }

  async createMany(aggregates: readonly TAggregate[], ctx: UnitOfWorkContext): Promise<void> {
    if (aggregates.length === 0) return;
    const rows = aggregates.map((a) => this.mapper.toPersistence(a));
    await this.writeDao.createMany(rows, ctx.trx);
    ctx.registerAggregate(...aggregates);
  }

  async update(aggregate: TAggregate, ctx: UnitOfWorkContext): Promise<void> {
    await this.writeDao.update(
      this.mapper.toPersistence(aggregate) as TRow & { updated_at?: Date },
      ctx.trx,
    );
    // Aggregate already registered in ctx via loadForUpdate*.
  }

  async updateMany(aggregates: readonly TAggregate[], ctx: UnitOfWorkContext): Promise<void> {
    if (aggregates.length === 0) return;
    const rows = aggregates.map((a) => this.mapper.toPersistence(a));
    await this.writeDao.updateMany(rows, ctx.trx);
    // Aggregates already registered in ctx via loadForUpdate*.
  }

  async delete(
    aggregate: TAggregate,
    expectedUpdatedAt: Date,
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    await this.writeDao.delete({ id: aggregate.id, updated_at: expectedUpdatedAt }, ctx.trx);
    // Aggregate already registered in ctx via loadForUpdate*.
  }

  async deleteMany(aggregates: readonly TAggregate[], ctx: UnitOfWorkContext): Promise<void> {
    if (aggregates.length === 0) return;
    await this.writeDao.deleteMany(
      aggregates.map((a) => a.id),
      ctx.trx,
    );
    // Aggregates already registered in ctx via loadForUpdate*.
  }
}
