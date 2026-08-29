import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseResult } from '../../src/database/database-result.type.js';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import type { Database } from '../../src/database/database.interface.js';
import { PgWriteDbAdapter } from '../../src/postgres/pg-write-db-adapter.js';

type Capture = {
  sql: string;
  params: readonly unknown[];
  trx: DatabaseTransaction | undefined;
};

/**
 * Stub Database that:
 *  - Returns seeded information_schema columns on the first call to
 *    info-schema for a given table (cached by the adapter after).
 *  - Captures every other query for assertions.
 */
class StubDatabase implements Database {
  private readonly columns: Record<string, Record<string, string>>;
  calls: Capture[] = [];
  resultQueue: DatabaseResult[] = [];

  constructor(columns: Record<string, Record<string, string>>) {
    this.columns = columns;
  }

  async query(
    sql: string,
    params: readonly unknown[] = [],
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult> {
    if (sql.includes('information_schema.columns')) {
      const tableName = String(params[0]);
      const cols = this.columns[tableName] ?? {};
      return {
        rows: Object.entries(cols).map(([column_name, data_type]) => ({
          column_name,
          data_type,
          udt_name: data_type === 'ARRAY' ? '_uuid' : data_type,
        })),
        rowCount: Object.keys(cols).length,
      };
    }

    this.calls.push({ sql, params, trx });
    return this.resultQueue.shift() ?? { rows: [], rowCount: 1 };
  }

  getDbTransaction = vi.fn();
  disconnect = vi.fn(async () => {});
  healthCheck = vi.fn(async () => ({ version: 'stub' }));
}

describe('PgWriteDbAdapter', () => {
  let db: StubDatabase;
  let adapter: PgWriteDbAdapter;

  beforeEach(() => {
    db = new StubDatabase({
      users: {
        id: 'uuid',
        name: 'text',
        age: 'integer',
        metadata: 'jsonb',
        created_at: 'timestamp with time zone',
        updated_at: 'timestamp with time zone',
        inserted_by: 'uuid',
        updated_by: 'uuid',
      },
    });
    adapter = new PgWriteDbAdapter(db);
  });

  describe('insert', () => {
    it('emits INSERT with type-cast placeholders and DB-generated timestamps', async () => {
      await adapter.insert({
        table: 'users',
        rows: [{ id: 'u1', name: 'Alice', age: 30 }],
      });

      const call = db.calls[0];
      expect(call?.sql).toBe(
        "INSERT INTO users (id, name, age, created_at, updated_at) VALUES ($1::UUID, $2::TEXT, $3::INTEGER, date_trunc('milliseconds', CURRENT_TIMESTAMP), date_trunc('milliseconds', CURRENT_TIMESTAMP))",
      );
      expect(call?.params).toEqual(['u1', 'Alice', 30]);
    });

    it('serializes JSONB values with JSON.stringify', async () => {
      await adapter.insert({
        table: 'users',
        rows: [{ id: 'u1', name: 'a', metadata: { foo: 'bar' } }],
      });

      const call = db.calls[0];
      expect(call?.params[2]).toBe('{"foo":"bar"}');
    });

    it('emits multi-row INSERT with one timestamp pair per row', async () => {
      await adapter.insert({
        table: 'users',
        rows: [
          { id: 'u1', name: 'a' },
          { id: 'u2', name: 'b' },
        ],
      });

      const call = db.calls[0];
      expect(call?.sql).toContain('VALUES');
      expect(call?.sql).toContain('$1::UUID, $2::TEXT');
      expect(call?.sql).toContain('$3::UUID, $4::TEXT');
      // One date_trunc pair per row:
      const matches = call?.sql.match(/date_trunc/g);
      expect(matches).toHaveLength(4);
    });

    it('no-ops on empty rows', async () => {
      const result = await adapter.insert({ table: 'users', rows: [] });
      expect(db.calls).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });

    it('appends RETURNING when requested', async () => {
      await adapter.insert({
        table: 'users',
        rows: [{ id: 'u1', name: 'a' }],
        returning: ['id', 'created_at'],
      });
      expect(db.calls[0]?.sql).toContain('RETURNING id, created_at');
    });

    it('passes trx through to Database.query', async () => {
      const trx = {} as DatabaseTransaction;
      await adapter.insert({ table: 'users', rows: [{ id: 'u1', name: 'a' }] }, trx);
      expect(db.calls[0]?.trx).toBe(trx);
    });
  });

  describe('update', () => {
    it('emits UPDATE with SET, WHERE, updated_at literal, no optimistic lock', async () => {
      await adapter.update({
        table: 'users',
        set: { name: 'Bob' },
        where: { id: 'u1' },
      });

      const call = db.calls[0];
      expect(call?.sql).toBe(
        "UPDATE users SET name = $1::TEXT, updated_at = date_trunc('milliseconds', CURRENT_TIMESTAMP) WHERE id = $2::UUID",
      );
      expect(call?.params).toEqual(['Bob', 'u1']);
    });

    it('appends optimistic-lock clause when optimisticLock present (Date → ISO)', async () => {
      const expectedAt = new Date('2026-04-01T12:00:00.000Z');
      await adapter.update({
        table: 'users',
        set: { name: 'Bob' },
        where: { id: 'u1' },
        optimisticLock: { column: 'updated_at', expected: expectedAt },
      });

      const call = db.calls[0];
      expect(call?.sql).toContain("AND updated_at = date_trunc('milliseconds', $3::timestamptz)");
      expect(call?.params).toEqual(['Bob', 'u1', '2026-04-01T12:00:00.000Z']);
    });
  });

  describe('updateMany', () => {
    it('emits a single UPDATE ... FROM (VALUES ...) statement', async () => {
      await adapter.updateMany({
        table: 'users',
        rows: [
          { id: 'u1', name: 'Alice', age: 30 },
          { id: 'u2', name: 'Bob', age: 31 },
        ],
      });

      const call = db.calls[0];
      expect(call?.sql).toBe(
        'UPDATE users AS t SET name = data.name, age = data.age, updated_at = ' +
          "date_trunc('milliseconds', CURRENT_TIMESTAMP) " +
          'FROM (VALUES ($1::TEXT, $2::INTEGER, $3::UUID), ($4::TEXT, $5::INTEGER, $6::UUID)) ' +
          'AS data(name, age, id) WHERE t.id = data.id',
      );
      expect(call?.params).toEqual(['Alice', 30, 'u1', 'Bob', 31, 'u2']);
    });

    it('serializes JSONB values per row', async () => {
      await adapter.updateMany({
        table: 'users',
        rows: [
          { id: 'u1', metadata: { foo: 'bar' } },
          { id: 'u2', metadata: { baz: 'qux' } },
        ],
      });

      expect(db.calls[0]?.params).toEqual(['{"foo":"bar"}', 'u1', '{"baz":"qux"}', 'u2']);
    });

    it('no-ops on empty rows', async () => {
      const result = await adapter.updateMany({ table: 'users', rows: [] });
      expect(db.calls).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });

    it('no-ops when rows contain only id (nothing to set)', async () => {
      const result = await adapter.updateMany({
        table: 'users',
        rows: [{ id: 'u1' }, { id: 'u2' }],
      });
      expect(db.calls).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });

    it('passes trx through to Database.query', async () => {
      const trx = {} as DatabaseTransaction;
      await adapter.updateMany({ table: 'users', rows: [{ id: 'u1', name: 'a' }] }, trx);
      expect(db.calls[0]?.trx).toBe(trx);
    });
  });

  describe('delete', () => {
    it('emits DELETE for single id', async () => {
      await adapter.delete({ table: 'users', where: { id: 'u1' } });
      expect(db.calls[0]?.sql).toBe('DELETE FROM users WHERE id = $1::UUID');
    });

    it('emits DELETE with = ANY(...) for array values', async () => {
      await adapter.delete({
        table: 'users',
        where: { id: ['u1', 'u2'] },
      });
      expect(db.calls[0]?.sql).toBe('DELETE FROM users WHERE id = ANY($1::UUID[])');
      expect(db.calls[0]?.params).toEqual([['u1', 'u2']]);
    });

    it('emits IS NULL for a literal null where value, with no parameter', async () => {
      await adapter.delete({ table: 'users', where: { name: null } });
      expect(db.calls[0]?.sql).toBe('DELETE FROM users WHERE name IS NULL');
      expect(db.calls[0]?.params).toEqual([]);
    });
  });

  describe('find / findForUpdate', () => {
    beforeEach(() => {
      db.resultQueue = [{ rows: [{ id: 'u1', name: 'a' }], rowCount: 1 }];
    });

    it('find emits SELECT with WHERE and LIMIT, no FOR UPDATE', async () => {
      await adapter.find({
        table: 'users',
        where: { id: 'u1' },
        limit: 1,
      });
      const sql = db.calls[0]?.sql ?? '';
      expect(sql).toContain('SELECT * FROM users');
      expect(sql).toContain('WHERE id = $1::UUID');
      expect(sql).toContain('LIMIT 1');
      expect(sql).not.toContain('FOR UPDATE');
    });

    it('findForUpdate appends FOR UPDATE', async () => {
      const trx = {} as DatabaseTransaction;
      await adapter.findForUpdate({ table: 'users', where: { id: 'u1' } }, trx);
      expect(db.calls[0]?.sql.endsWith('FOR UPDATE')).toBe(true);
      expect(db.calls[0]?.trx).toBe(trx);
    });

    it('supports orderBy', async () => {
      await adapter.find({
        table: 'users',
        where: { id: 'u1' },
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      });
      expect(db.calls[0]?.sql).toContain('ORDER BY created_at DESC');
    });

    it('reproduces the sweep-job shape: locked, range-filtered, ordered', async () => {
      const trx = {} as DatabaseTransaction;
      const now = new Date('2026-08-29T00:00:00.000Z');
      await adapter.findForUpdate(
        {
          table: 'users',
          where: { name: 'PENDING', created_at__lt: now },
          orderBy: [{ column: 'id', direction: 'asc' }],
        },
        trx,
      );
      expect(db.calls[0]?.sql).toBe(
        'SELECT * FROM users WHERE name = $1::TEXT AND created_at < $2::TIMESTAMPTZ ORDER BY id ASC FOR UPDATE',
      );
      expect(db.calls[0]?.params).toEqual(['PENDING', now]);
      expect(db.calls[0]?.trx).toBe(trx);
    });
  });

  describe('exists', () => {
    it('returns true when matching row present', async () => {
      db.resultQueue = [{ rows: [{ '?column?': 1 }], rowCount: 1 }];
      const result = await adapter.exists({
        table: 'users',
        where: { name: 'Alice' },
      });
      expect(result).toBe(true);
      expect(db.calls[0]?.sql).toContain('SELECT 1 FROM users WHERE');
      expect(db.calls[0]?.sql).toContain('LIMIT 1');
    });

    it('returns false when no rows match', async () => {
      db.resultQueue = [{ rows: [], rowCount: 0 }];
      const result = await adapter.exists({
        table: 'users',
        where: { name: 'Nobody' },
      });
      expect(result).toBe(false);
    });
  });

  describe('info-schema cache', () => {
    it('queries information_schema once per table, regardless of call count', async () => {
      const spy = vi.spyOn(db, 'query');
      await adapter.insert({
        table: 'users',
        rows: [{ id: 'u1', name: 'a' }],
      });
      await adapter.insert({
        table: 'users',
        rows: [{ id: 'u2', name: 'b' }],
      });
      await adapter.update({
        table: 'users',
        set: { name: 'c' },
        where: { id: 'u1' },
      });

      const infoSchemaCalls = spy.mock.calls.filter(([sql]) =>
        sql.includes('information_schema.columns'),
      );
      expect(infoSchemaCalls).toHaveLength(1);
    });
  });
});
