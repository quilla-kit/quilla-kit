import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from './filter-query.type.js';
import type { SelectOptions } from './read-db-adapter.interface.js';

export type OptimisticLock = {
  readonly column: string;
  readonly expected: unknown;
};

export type InsertOptions = {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly returning?: readonly string[];
};

export type UpdateOptions<T> = {
  readonly table: string;
  readonly set: Record<string, unknown>;
  readonly where: FilterQuery<T>;
  readonly optimisticLock?: OptimisticLock;
  readonly returning?: readonly string[];
};

/**
 * Bulk update via a single `UPDATE ... FROM (VALUES ...)` statement. Each
 * row in `rows` must include `id` (used as the join key) plus the same set
 * of columns to update — heterogeneous keys across rows are unsupported
 * (the VALUES table requires a fixed schema). No optimistic locking: bulk
 * update is meant to follow `findManyForUpdate` so row-level locks held
 * inside the transaction already serialize concurrent writers.
 */
export type UpdateManyOptions = {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
};

export type DeleteOptions<T> = {
  readonly table: string;
  readonly where: FilterQuery<T>;
  readonly optimisticLock?: OptimisticLock;
};

export type ExistsOptions<T> = {
  readonly table: string;
  readonly where: FilterQuery<T>;
};

/**
 * Write-side adapter. Owns a `Database` reference internally (for schema
 * introspection and pool access), builds SQL with dialect-specific
 * primitives, and executes it. DAOs call adapter methods directly; the
 * adapter's Database is never exposed.
 *
 * CQRS note: `find`/`exists` are write-side reads (unlocked, optional trx
 * — for pre-create uniqueness checks), and `findForUpdate` is the locked
 * variant (required trx — for read-before-update). Read projections live
 * entirely on `ReadDbAdapter`.
 */
export interface WriteDbAdapter {
  insert(opts: InsertOptions, trx?: DatabaseTransaction): Promise<DatabaseResult>;

  update<T>(opts: UpdateOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult>;

  updateMany(opts: UpdateManyOptions, trx?: DatabaseTransaction): Promise<DatabaseResult>;

  delete<T>(opts: DeleteOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult>;

  find<T>(opts: SelectOptions<T>, trx?: DatabaseTransaction): Promise<readonly T[]>;

  findForUpdate<T>(opts: SelectOptions<T>, trx: DatabaseTransaction): Promise<readonly T[]>;

  exists<T>(opts: ExistsOptions<T>, trx?: DatabaseTransaction): Promise<boolean>;
}
