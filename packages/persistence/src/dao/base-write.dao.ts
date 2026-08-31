import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { WriteDbAdapter } from '../db-adapter/write-db-adapter.interface.js';
import { OptimisticLockError } from '../errors/optimistic-lock.error.js';
import { AUDIT_COLUMNS, INSERT_EXCLUDED_KEYS, UPDATE_EXCLUDED_KEYS } from './audit-columns.js';

/**
 * Write-side DAO. Orchestrates row writes with audit-field injection,
 * excluded-keys filtering, and optimistic-lock enforcement. Delegates SQL
 * generation and execution to `WriteDbAdapter`.
 *
 * `find*` — returns raw `TRow` (DB-level); the repository layer wraps
 * these into `load*` for aggregate loading.
 *
 * Unlocked reads (`findOne` / `findMany` / `existsBy`) accept optional
 * `trx` for pre-create uniqueness checks. Locked reads (`findOneForUpdate`
 * / `findManyForUpdate`) require `trx` — they're for read-before-update.
 *
 * `updateMany` issues a single `UPDATE ... FROM (VALUES ...)` statement
 * via the adapter — no per-row optimistic lock. Callers needing
 * concurrency control should `findManyForUpdate` first; the row-level
 * locks held inside `trx` serialize concurrent writers for the duration
 * of the unit of work. `trx` is required.
 *
 * `delete` accepts an optional `updated_at` (mirroring `update`'s
 * optimistic-lock contract) and throws `OptimisticLockError` if the row
 * was concurrently modified since it was read. `deleteMany` has no
 * per-row lock, for the same reason as `updateMany`.
 */
export abstract class BaseWriteDao<TRow extends { id: string }> {
  protected abstract readonly tableName: string;

  constructor(
    protected readonly adapter: WriteDbAdapter,
    protected readonly contextProvider: ExecutionContextProvider,
  ) {}

  async findOneById(id: string, trx?: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.find<TRow>(
      {
        table: this.tableName,
        where: { id } as FilterQuery<TRow>,
        limit: 1,
      },
      trx,
    );
    return rows[0] ?? null;
  }

  async findOne(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.find<TRow>({ table: this.tableName, where, limit: 1 }, trx);
    return rows[0] ?? null;
  }

  async findMany(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<readonly TRow[]> {
    return this.adapter.find<TRow>({ table: this.tableName, where }, trx);
  }

  async existsBy(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<boolean> {
    return this.adapter.exists<TRow>({ table: this.tableName, where }, trx);
  }

  async findOneForUpdate(where: FilterQuery<TRow>, trx: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.findForUpdate<TRow>(
      { table: this.tableName, where, limit: 1 },
      trx,
    );
    return rows[0] ?? null;
  }

  async findManyForUpdate(
    where: FilterQuery<TRow>,
    trx: DatabaseTransaction,
  ): Promise<readonly TRow[]> {
    return this.adapter.findForUpdate<TRow>({ table: this.tableName, where }, trx);
  }

  async create(row: TRow, trx?: DatabaseTransaction): Promise<void> {
    const userId = this.contextProvider.getContext().session?.userId;
    await this.adapter.insert(
      { table: this.tableName, rows: [this.prepareInsertRow(row, userId)] },
      trx,
    );
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    if (rows.length === 0) return;
    const userId = this.contextProvider.getContext().session?.userId;
    const prepared = rows.map((row) => this.prepareInsertRow(row, userId));
    await this.adapter.insert({ table: this.tableName, rows: prepared }, trx);
  }

  async update(row: TRow & { updated_at?: Date }, trx?: DatabaseTransaction): Promise<void> {
    const { id, updated_at } = row;
    const userId = this.contextProvider.getContext().session?.userId;
    const result = await this.adapter.update<TRow>(
      {
        table: this.tableName,
        set: this.prepareUpdateRow(row, userId),
        where: { id } as FilterQuery<TRow>,
        ...(updated_at !== undefined
          ? { optimisticLock: { column: AUDIT_COLUMNS.updatedAt, expected: updated_at } }
          : {}),
      },
      trx,
    );

    if (updated_at !== undefined && result.rowCount === 0) {
      throw new OptimisticLockError({ entity: this.tableName, id });
    }
  }

  async updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<void> {
    if (rows.length === 0) return;
    const userId = this.contextProvider.getContext().session?.userId;
    const prepared = rows.map((row) => this.prepareUpdateRowWithId(row, userId));
    await this.adapter.updateMany({ table: this.tableName, rows: prepared }, trx);
  }

  async delete(
    row: { id: string; updated_at?: Date | undefined },
    trx?: DatabaseTransaction,
  ): Promise<void> {
    const { id, updated_at } = row;
    const result = await this.adapter.delete<TRow>(
      {
        table: this.tableName,
        where: { id } as FilterQuery<TRow>,
        ...(updated_at !== undefined
          ? { optimisticLock: { column: AUDIT_COLUMNS.updatedAt, expected: updated_at } }
          : {}),
      },
      trx,
    );

    if (updated_at !== undefined && result.rowCount === 0) {
      throw new OptimisticLockError({ entity: this.tableName, id });
    }
  }

  async deleteMany(ids: readonly string[], trx?: DatabaseTransaction): Promise<void> {
    if (ids.length === 0) return;
    await this.adapter.delete<TRow>(
      {
        table: this.tableName,
        where: { id: ids } as FilterQuery<TRow>,
      },
      trx,
    );
  }

  private prepareInsertRow(row: TRow, userId: string | undefined): Record<string, unknown> {
    return {
      ...this.stripKeys(row, INSERT_EXCLUDED_KEYS),
      [AUDIT_COLUMNS.insertedBy]: userId,
      [AUDIT_COLUMNS.updatedBy]: userId,
    };
  }

  private prepareUpdateRow(row: TRow, userId: string | undefined): Record<string, unknown> {
    return {
      ...this.stripKeys(row, UPDATE_EXCLUDED_KEYS),
      [AUDIT_COLUMNS.updatedBy]: userId,
    };
  }

  private prepareUpdateRowWithId(row: TRow, userId: string | undefined): Record<string, unknown> {
    return {
      id: row.id,
      ...this.stripKeys(row, UPDATE_EXCLUDED_KEYS),
      [AUDIT_COLUMNS.updatedBy]: userId,
    };
  }

  private stripKeys(row: TRow, excluded: ReadonlySet<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (!excluded.has(key)) {
        out[key] = value;
      }
    }
    return out;
  }
}
