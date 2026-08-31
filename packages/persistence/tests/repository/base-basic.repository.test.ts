import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { BaseBasicRepository } from '../../src/repository/base-basic.repository.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';

type ThingRow = { id: string; name: string; updated_at?: Date };

class ThingDao extends BaseWriteDao<ThingRow> {
  protected readonly tableName = 'things';
}

class ThingRepo extends BaseBasicRepository<ThingRow> {}

describe('BaseBasicRepository', () => {
  let adapter: FakeWriteDbAdapter;
  let repo: ThingRepo;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    const ctx = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'c1',
      executionAttemptId: 'attempt-1',
      session: { scopeId: 's1', userId: 'u1' },
    });
    repo = new ThingRepo(new ThingDao(adapter, ctx));
    trx = new FakeDatabaseTransaction();
  });

  it('create delegates to dao.create', async () => {
    await repo.create({ id: 't1', name: 'a' }, trx);
    expect(adapter.insertCalls).toHaveLength(1);
    expect(adapter.insertCalls[0]?.trx).toBe(trx);
  });

  it('createMany delegates to dao.createMany', async () => {
    await repo.createMany(
      [
        { id: 't1', name: 'a' },
        { id: 't2', name: 'b' },
      ],
      trx,
    );
    expect(adapter.insertCalls).toHaveLength(1);
    expect(adapter.insertCalls[0]?.opts.rows).toHaveLength(2);
  });

  it('update delegates to dao.update', async () => {
    await repo.update({ id: 't1', name: 'a' }, trx);
    expect(adapter.updateCalls).toHaveLength(1);
    expect(adapter.updateCalls[0]?.opts.where).toEqual({ id: 't1' });
  });

  it('updateMany delegates to dao.updateMany (single adapter call)', async () => {
    await repo.updateMany(
      [
        { id: 't1', name: 'a' },
        { id: 't2', name: 'b' },
      ],
      trx,
    );
    expect(adapter.updateManyCalls).toHaveLength(1);
    expect(adapter.updateManyCalls[0]?.opts.rows).toHaveLength(2);
  });

  it('delete delegates to dao.delete', async () => {
    await repo.delete({ id: 't1' }, trx);
    expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: 't1' });
  });

  it('delete passes updated_at as optimisticLock when present', async () => {
    const updatedAt = new Date('2026-01-01');
    await repo.delete({ id: 't1', updated_at: updatedAt }, trx);
    expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
      column: 'updated_at',
      expected: updatedAt,
    });
  });

  it('deleteMany delegates to dao.deleteMany', async () => {
    await repo.deleteMany(['t1', 't2'], trx);
    expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: ['t1', 't2'] });
  });
});
