import { beforeEach, describe, expect, it } from 'vitest';
import { BaseWriteDao } from '../../src/dao/base-write.dao.js';
import { OptimisticLockError } from '../../src/errors/optimistic-lock.error.js';
import { FakeExecutionContextProvider } from '../helpers/fake-context-provider.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeWriteDbAdapter } from '../helpers/fake-db-adapter.js';

type UserRow = {
  id: string;
  name: string;
  created_at?: Date;
  updated_at?: Date;
  inserted_by?: string;
  updated_by?: string;
};

class UserDao extends BaseWriteDao<UserRow> {
  protected readonly tableName = 'users';
}

describe('BaseWriteDao', () => {
  let adapter: FakeWriteDbAdapter;
  let ctxProvider: FakeExecutionContextProvider;
  let dao: UserDao;
  let trx: FakeDatabaseTransaction;

  beforeEach(() => {
    adapter = new FakeWriteDbAdapter();
    ctxProvider = new FakeExecutionContextProvider({
      actorType: 'user',
      correlationId: 'corr-1',
      executionAttemptId: 'attempt-1',
      session: { scopeId: 'scope-1', userId: 'user-42' },
    });
    dao = new UserDao(adapter, ctxProvider);
    trx = new FakeDatabaseTransaction();
  });

  describe('create', () => {
    it('injects inserted_by and updated_by from the execution context', async () => {
      await dao.create({ id: 'u1', name: 'Alice' });

      expect(adapter.insertCalls).toHaveLength(1);
      expect(adapter.insertCalls[0]?.opts.rows[0]).toEqual({
        id: 'u1',
        name: 'Alice',
        inserted_by: 'user-42',
        updated_by: 'user-42',
      });
    });

    it('strips created_at and updated_at from input (DB-generated)', async () => {
      await dao.create({
        id: 'u1',
        name: 'Alice',
        created_at: new Date(),
        updated_at: new Date(),
      });

      const inserted = adapter.insertCalls[0]?.opts.rows[0];
      expect(inserted).not.toHaveProperty('created_at');
      expect(inserted).not.toHaveProperty('updated_at');
    });

    it('passes trx through to the adapter when present', async () => {
      await dao.create({ id: 'u1', name: 'Alice' }, trx);
      expect(adapter.insertCalls[0]?.trx).toBe(trx);
    });
  });

  describe('createMany', () => {
    it('no-ops on empty array', async () => {
      await dao.createMany([]);
      expect(adapter.insert).not.toHaveBeenCalled();
    });

    it('prepares each row with audit fields', async () => {
      await dao.createMany([
        { id: 'u1', name: 'a' },
        { id: 'u2', name: 'b' },
      ]);

      const rows = adapter.insertCalls[0]?.opts.rows;
      expect(rows).toHaveLength(2);
      expect(rows?.[0]).toMatchObject({ inserted_by: 'user-42' });
      expect(rows?.[1]).toMatchObject({ inserted_by: 'user-42' });
    });
  });

  describe('update', () => {
    it('injects updated_by but not inserted_by', async () => {
      await dao.update({ id: 'u1', name: 'Alice2' }, trx);

      const set = adapter.updateCalls[0]?.opts.set;
      expect(set).toMatchObject({ name: 'Alice2', updated_by: 'user-42' });
      expect(set).not.toHaveProperty('inserted_by');
    });

    it('strips id and immutable fields from set clause', async () => {
      await dao.update(
        {
          id: 'u1',
          name: 'Alice2',
          inserted_by: 'old-user',
          created_at: new Date(),
        },
        trx,
      );

      const set = adapter.updateCalls[0]?.opts.set;
      expect(set).not.toHaveProperty('id');
      expect(set).not.toHaveProperty('inserted_by');
      expect(set).not.toHaveProperty('created_at');
      expect(set).not.toHaveProperty('updated_at');
    });

    it('passes updated_at as optimisticLock when present', async () => {
      const updatedAt = new Date('2026-01-01');
      await dao.update({ id: 'u1', name: 'x', updated_at: updatedAt }, trx);

      expect(adapter.updateCalls[0]?.opts.optimisticLock).toEqual({
        column: 'updated_at',
        expected: updatedAt,
      });
    });

    it('omits optimisticLock when updated_at is absent', async () => {
      await dao.update({ id: 'u1', name: 'x' }, trx);
      expect(adapter.updateCalls[0]?.opts.optimisticLock).toBeUndefined();
    });

    it('throws OptimisticLockError when rowCount is 0 and updated_at was provided', async () => {
      adapter.updateResults = [{ rows: [], rowCount: 0 }];

      await expect(
        dao.update({ id: 'u1', name: 'x', updated_at: new Date() }, trx),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('does not throw when rowCount is 0 but no optimistic lock was requested', async () => {
      adapter.updateResults = [{ rows: [], rowCount: 0 }];

      await expect(dao.update({ id: 'u1', name: 'x' }, trx)).resolves.toBeUndefined();
    });
  });

  describe('updateMany', () => {
    it('no-ops on empty array', async () => {
      await dao.updateMany([], trx);
      expect(adapter.updateMany).not.toHaveBeenCalled();
    });

    it('issues a single adapter.updateMany call with all rows', async () => {
      await dao.updateMany(
        [
          { id: 'u1', name: 'a' },
          { id: 'u2', name: 'b' },
        ],
        trx,
      );

      expect(adapter.updateManyCalls).toHaveLength(1);
      expect(adapter.updateManyCalls[0]?.opts.table).toBe('users');
      expect(adapter.updateManyCalls[0]?.opts.rows).toHaveLength(2);
      expect(adapter.updateManyCalls[0]?.trx).toBe(trx);
    });

    it('keeps id and injects updated_by per row', async () => {
      await dao.updateMany(
        [
          { id: 'u1', name: 'a' },
          { id: 'u2', name: 'b' },
        ],
        trx,
      );

      const rows = adapter.updateManyCalls[0]?.opts.rows;
      expect(rows?.[0]).toEqual({ id: 'u1', name: 'a', updated_by: 'user-42' });
      expect(rows?.[1]).toEqual({ id: 'u2', name: 'b', updated_by: 'user-42' });
    });

    it('strips immutable/audit keys from rows but keeps id', async () => {
      await dao.updateMany(
        [
          {
            id: 'u1',
            name: 'a',
            inserted_by: 'old',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        trx,
      );

      const row = adapter.updateManyCalls[0]?.opts.rows[0];
      expect(row).toHaveProperty('id', 'u1');
      expect(row).not.toHaveProperty('inserted_by');
      expect(row).not.toHaveProperty('created_at');
      expect(row).not.toHaveProperty('updated_at');
    });
  });

  describe('delete', () => {
    it('passes id as where clause', async () => {
      await dao.delete({ id: 'u1' });
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: 'u1' });
    });

    it('passes updated_at as optimisticLock when present', async () => {
      const updatedAt = new Date('2026-01-01');
      await dao.delete({ id: 'u1', updated_at: updatedAt }, trx);

      expect(adapter.deleteCalls[0]?.opts.optimisticLock).toEqual({
        column: 'updated_at',
        expected: updatedAt,
      });
    });

    it('omits optimisticLock when updated_at is absent', async () => {
      await dao.delete({ id: 'u1' }, trx);
      expect(adapter.deleteCalls[0]?.opts.optimisticLock).toBeUndefined();
    });

    it('throws OptimisticLockError when rowCount is 0 and updated_at was provided', async () => {
      adapter.deleteResults = [{ rows: [], rowCount: 0 }];

      await expect(dao.delete({ id: 'u1', updated_at: new Date() }, trx)).rejects.toThrow(
        OptimisticLockError,
      );
    });

    it('does not throw when rowCount is 0 but no optimistic lock was requested', async () => {
      adapter.deleteResults = [{ rows: [], rowCount: 0 }];

      await expect(dao.delete({ id: 'u1' }, trx)).resolves.toBeUndefined();
    });
  });

  describe('deleteMany', () => {
    it('no-ops on empty array', async () => {
      await dao.deleteMany([]);
      expect(adapter.delete).not.toHaveBeenCalled();
    });

    it('passes ids array as where clause', async () => {
      await dao.deleteMany(['u1', 'u2']);
      expect(adapter.deleteCalls[0]?.opts.where).toEqual({ id: ['u1', 'u2'] });
    });
  });

  describe('read-side methods (unlocked)', () => {
    it('findOne uses find() on the adapter with limit 1', async () => {
      adapter.findResults = [[{ id: 'u1', name: 'a' }]];
      const row = await dao.findOne({ name: 'a' });

      expect(adapter.findCalls[0]?.opts).toEqual({
        table: 'users',
        where: { name: 'a' },
        limit: 1,
      });
      expect(row).toEqual({ id: 'u1', name: 'a' });
    });

    it('findOne returns null when no rows', async () => {
      adapter.findResults = [[]];
      expect(await dao.findOne({ id: 'missing' })).toBeNull();
    });

    it('existsBy delegates to adapter.exists', async () => {
      adapter.existsResults = [true];
      const result = await dao.existsBy({ id: 'u1' });
      expect(adapter.existsCalls[0]?.opts).toEqual({
        table: 'users',
        where: { id: 'u1' },
      });
      expect(result).toBe(true);
    });

    it('find* methods accept optional trx for read-within-write-trx', async () => {
      adapter.findResults = [[{ id: 'u1', name: 'a' }]];
      await dao.findOne({ id: 'u1' }, trx);
      expect(adapter.findCalls[0]?.trx).toBe(trx);
    });
  });

  describe('findOneForUpdate (locked)', () => {
    it('uses findForUpdate on the adapter', async () => {
      adapter.findForUpdateResults = [[{ id: 'u1', name: 'a' }]];

      const row = await dao.findOneForUpdate({ id: 'u1' }, trx);
      expect(adapter.findForUpdateCalls).toHaveLength(1);
      expect(adapter.findForUpdateCalls[0]?.trx).toBe(trx);
      expect(row).toEqual({ id: 'u1', name: 'a' });
    });

    it('returns null when no rows match', async () => {
      adapter.findForUpdateResults = [[]];
      expect(await dao.findOneForUpdate({ id: 'u1' }, trx)).toBeNull();
    });
  });
});
