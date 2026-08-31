import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { SelectOptions } from '../db-adapter/read-db-adapter.interface.js';
import type {
  DeleteOptions,
  ExistsOptions,
  InsertOptions,
  UpdateManyOptions,
  UpdateOptions,
  WriteDbAdapter,
} from '../db-adapter/write-db-adapter.interface.js';
import { PgColumnTypeCache, buildWhere, mapPostgresType, runSelect } from './pg-sql.js';

const TIMESTAMP_LITERAL = `date_trunc('milliseconds', CURRENT_TIMESTAMP)`;
const timestampComparison = (paramIndex: number): string =>
  `date_trunc('milliseconds', $${paramIndex}::timestamptz)`;

/**
 * Postgres `WriteDbAdapter`. Resolves column types once per table via
 * `PgColumnTypeCache`, emits explicit parameter casts, JSON.stringify's
 * JSONB values, and renders millisecond-truncated timestamps so
 * optimistic-lock comparisons round-trip with JS `Date`.
 *
 * Accepts an optional shared `PgColumnTypeCache` so a sibling
 * `PgReadDbAdapter` can share the same type cache (one info-schema fetch
 * per table, regardless of which adapter hits it first).
 */
export class PgWriteDbAdapter implements WriteDbAdapter {
  private readonly columnTypes: PgColumnTypeCache;

  constructor(db: Database, columnTypeCache?: PgColumnTypeCache) {
    this.columnTypes = columnTypeCache ?? new PgColumnTypeCache(db);
    this.db = db;
  }

  private readonly db: Database;

  async insert(opts: InsertOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    if (opts.rows.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const types = await this.columnTypes.get(opts.table);
    const firstRow = opts.rows[0] as Record<string, unknown>;
    const keys = Object.keys(firstRow);

    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    for (const row of opts.rows) {
      const rowData = row as Record<string, unknown>;
      const placeholders = keys.map((key) => {
        values.push(serializeValue(types[key], rowData[key]));
        return `$${values.length}::${mapPostgresType(types[key])}`;
      });
      rowPlaceholders.push(
        `(${placeholders.join(', ')}, ${TIMESTAMP_LITERAL}, ${TIMESTAMP_LITERAL})`,
      );
    }

    const allColumns = [...keys, 'created_at', 'updated_at'].join(', ');
    const returning = buildReturning(opts.returning);
    const sql = `INSERT INTO ${opts.table} (${allColumns}) VALUES ${rowPlaceholders.join(', ')}${returning}`;

    return this.db.query(sql, values, trx);
  }

  async update<T>(opts: UpdateOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    const setKeys = Object.keys(opts.set);

    const values: unknown[] = [];
    const setClauses = setKeys.map((key) => {
      values.push(serializeValue(types[key], opts.set[key]));
      return `${key} = $${values.length}::${mapPostgresType(types[key])}`;
    });
    setClauses.push(`updated_at = ${TIMESTAMP_LITERAL}`);

    const where = buildWhere(opts.where, types, values.length);
    values.push(...where.values);

    let whereSql = where.sql;
    if (opts.optimisticLock) {
      values.push(
        opts.optimisticLock.expected instanceof Date
          ? opts.optimisticLock.expected.toISOString()
          : opts.optimisticLock.expected,
      );
      whereSql += ` AND ${opts.optimisticLock.column} = ${timestampComparison(values.length)}`;
    }

    const returning = buildReturning(opts.returning);
    const sql = `UPDATE ${opts.table} SET ${setClauses.join(', ')} WHERE ${whereSql}${returning}`;

    return this.db.query(sql, values, trx);
  }

  async updateMany(opts: UpdateManyOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    if (opts.rows.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const types = await this.columnTypes.get(opts.table);
    const firstRow = opts.rows[0] as Record<string, unknown>;
    const allKeys = Object.keys(firstRow);
    const setKeys = allKeys.filter((key) => key !== 'id');

    if (setKeys.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    for (const row of opts.rows) {
      const rowData = row as Record<string, unknown>;
      const setPlaceholders = setKeys.map((key) => {
        values.push(serializeValue(types[key], rowData[key]));
        return `$${values.length}::${mapPostgresType(types[key])}`;
      });
      values.push(rowData.id);
      rowPlaceholders.push(
        `(${setPlaceholders.join(', ')}, $${values.length}::${mapPostgresType(types.id)})`,
      );
    }

    const setClauses = setKeys.map((key) => `${key} = data.${key}`);
    setClauses.push(`updated_at = ${TIMESTAMP_LITERAL}`);

    const dataColumns = [...setKeys, 'id'].join(', ');
    const sql = `UPDATE ${opts.table} AS t SET ${setClauses.join(', ')} FROM (VALUES ${rowPlaceholders.join(', ')}) AS data(${dataColumns}) WHERE t.id = data.id`;

    return this.db.query(sql, values, trx);
  }

  async delete<T>(opts: DeleteOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    const where = buildWhere(opts.where, types);
    const values = [...where.values];

    let whereSql = where.sql;
    if (opts.optimisticLock) {
      values.push(
        opts.optimisticLock.expected instanceof Date
          ? opts.optimisticLock.expected.toISOString()
          : opts.optimisticLock.expected,
      );
      whereSql += ` AND ${opts.optimisticLock.column} = ${timestampComparison(values.length)}`;
    }

    const sql = `DELETE FROM ${opts.table} WHERE ${whereSql}`;
    return this.db.query(sql, values, trx);
  }

  async find<T>(opts: SelectOptions<T>, trx?: DatabaseTransaction): Promise<readonly T[]> {
    const result = await this.executeSelect(opts, false, trx);
    return result.rows as readonly T[];
  }

  async findForUpdate<T>(opts: SelectOptions<T>, trx: DatabaseTransaction): Promise<readonly T[]> {
    const result = await this.executeSelect(opts, true, trx);
    return result.rows as readonly T[];
  }

  async exists<T>(opts: ExistsOptions<T>, trx?: DatabaseTransaction): Promise<boolean> {
    const types = await this.columnTypes.get(opts.table);
    const where = buildWhere(opts.where, types);
    const sql = `SELECT 1 FROM ${opts.table} WHERE ${where.sql} LIMIT 1`;
    const result = await this.db.query(sql, where.values, trx);
    return result.rows.length > 0;
  }

  private async executeSelect<T>(
    opts: SelectOptions<T>,
    forUpdate: boolean,
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    return runSelect(this.db, opts, types, { forUpdate, trx });
  }
}

function buildReturning(returning: readonly string[] | undefined): string {
  if (!returning || returning.length === 0) return '';
  return ` RETURNING ${returning.join(', ')}`;
}

function serializeValue(dataType: string | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const lower = dataType?.toLowerCase();
  if (lower === 'jsonb' || lower === 'json') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return value;
}
