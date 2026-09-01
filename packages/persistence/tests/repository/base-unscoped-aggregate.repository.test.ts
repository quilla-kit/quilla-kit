import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { BaseUnscopedAggregateRepository } from '../../src/repository/base-unscoped-aggregate.repository.js';
import type { PersistenceMapper } from '../../src/repository/mapper.interface.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type AggRow = { id: string; name: string };

class AggDao extends BaseWriteDao<AggRow> {
  protected readonly tableName = 'aggs';
}

class TestMapper implements PersistenceMapper<TestAggregate, AggRow> {
  toDomain(row: AggRow): TestAggregate {
    return new TestAggregate({ id: row.id, name: row.name }, row.id);
  }
  toPersistence(agg: TestAggregate): AggRow {
    return {
      id: agg.id,
      name: (agg as unknown as { props: { name: string } }).props.name,
    };
  }
}

class UnscopedRepo extends BaseUnscopedAggregateRepository<TestAggregate, AggRow> {}

describe('BaseUnscopedAggregateRepository', () => {
  let adapter: FakeWriteDbAdapter;
  let repo: UnscopedRepo;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    const ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'c1',
      executionAttemptId: 'attempt-1',
      session: { scopeId: 's1', userId: 'u1' },
    });
    const dao = new AggDao(adapter, ctx);
    repo = new UnscopedRepo(new TestMapper(), dao);
    trx = new FakeDatabaseTransaction();
  });

  it('returns null when loadById finds nothing (not a throw)', async () => {
    adapter.findResults = [[]];
    const agg = await repo.loadById('missing');
    expect(agg).toBeNull();
  });

  it('returns the aggregate when found', async () => {
    adapter.findResults = [[{ id: 'a1', name: 'foo' }]];
    const agg = await repo.loadById('a1');
    expect(agg?.id).toBe('a1');
  });

  describe('createMany', () => {
    it('no-ops on empty array', async () => {
      const ctx = {
        trx,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };

      await repo.createMany([], ctx as Parameters<typeof repo.createMany>[1]);
      expect(adapter.insertCalls).toHaveLength(0);
    });

    it('inserts all rows in one call and registers every aggregate', async () => {
      const registered: unknown[] = [];
      const ctx = {
        trx,
        registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
        registerIntegrationEvent: () => {},
      };

      const a1 = TestAggregate.create('a1', 'one');
      const a2 = TestAggregate.create('a2', 'two');

      await repo.createMany([a1, a2], ctx as Parameters<typeof repo.createMany>[1]);

      expect(adapter.insertCalls).toHaveLength(1);
      expect(adapter.insertCalls[0]?.opts.rows).toHaveLength(2);
      expect(registered).toEqual([a1, a2]);
    });
  });

  describe('delete', () => {
    it('passes the explicit expectedUpdatedAt through as optimisticLock', async () => {
      const updatedAt = new Date('2026-01-01');
      const agg = new TestAggregate({ id: 'a1', name: 'foo', updatedAt }, 'a1');
      const ctx = {
        trx,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };

      await repo.delete(agg, updatedAt, ctx as Parameters<typeof repo.delete>[2]);

      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: 'a1' });
      expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
        column: 'updated_at',
        expected: updatedAt,
      });
    });

    it('forwards a caller-supplied expectedUpdatedAt even when it differs from aggregate state', async () => {
      const staleClaimed = new Date('2025-06-01');
      const agg = new TestAggregate(
        { id: 'a1', name: 'foo', updatedAt: new Date('2026-01-01') },
        'a1',
      );
      const ctx = {
        trx,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };

      await repo.delete(agg, staleClaimed, ctx as Parameters<typeof repo.delete>[2]);

      expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
        column: 'updated_at',
        expected: staleClaimed,
      });
    });
  });

  describe('updateMany / deleteMany', () => {
    it('updateMany delegates to dao.updateMany without re-registering', async () => {
      const registered: unknown[] = [];
      const ctx = {
        trx,
        registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
        registerIntegrationEvent: () => {},
      };

      const a1 = TestAggregate.create('a1', 'one');
      const a2 = TestAggregate.create('a2', 'two');

      await repo.updateMany([a1, a2], ctx as Parameters<typeof repo.updateMany>[1]);

      expect(adapter.updateManyCalls).toHaveLength(1);
      expect(adapter.updateManyCalls[0]?.opts.rows).toHaveLength(2);
      expect(registered).toEqual([]);
    });

    it('deleteMany passes ids to dao.deleteMany without re-registering', async () => {
      const registered: unknown[] = [];
      const ctx = {
        trx,
        registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
        registerIntegrationEvent: () => {},
      };

      const a1 = TestAggregate.create('a1', 'one');
      const a2 = TestAggregate.create('a2', 'two');

      await repo.deleteMany([a1, a2], ctx as Parameters<typeof repo.deleteMany>[1]);

      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: ['a1', 'a2'] });
      expect(registered).toEqual([]);
    });

    it('updateMany no-ops on empty', async () => {
      const ctx = {
        trx,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };
      await repo.updateMany([], ctx as Parameters<typeof repo.updateMany>[1]);
      expect(adapter.updateManyCalls).toHaveLength(0);
    });

    it('deleteMany no-ops on empty', async () => {
      const ctx = {
        trx,
        registerAggregate: () => {},
        registerIntegrationEvent: () => {},
      };
      await repo.deleteMany([], ctx as Parameters<typeof repo.deleteMany>[1]);
      expect(adapter.deleteCalls).toHaveLength(0);
    });
  });

  it('registers aggregate in UoW context on loadForUpdateById', async () => {
    adapter.findForUpdateResults = [[{ id: 'a1', name: 'foo' }]];

    const registered: unknown[] = [];
    const ctx = {
      trx,
      registerAggregate: (...aggs: unknown[]) => registered.push(...aggs),
      registerIntegrationEvent: () => {},
    };

    const agg = await repo.loadForUpdateById(
      'a1',
      ctx as Parameters<typeof repo.loadForUpdateById>[1],
    );
    expect(registered[0]).toBe(agg);
  });
});
