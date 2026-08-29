import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { SelectOptions } from '../db-adapter/read-db-adapter.interface.js';
import {
  ALL_FILTER_OPERATORS,
  FILTER_DELIMITER,
  type FilterOperator,
} from '../query/field-descriptor.type.js';

export type ColumnTypeMap = Record<string, string>;

const KNOWN_OPERATORS: ReadonlySet<FilterOperator> = new Set(ALL_FILTER_OPERATORS);

/**
 * Splits a filter key like `expiresAt__lt` into its field and operator.
 * Keys with no `__` suffix default to `eq` and report `hadSuffix: false`,
 * letting callers apply suffix-only rules (e.g. stricter field-name
 * validation) without re-deriving whether a suffix was present. Shared by
 * the read-side `SqlQueryBuilder` and the write-side `buildWhere` so both
 * sides use one operator vocabulary.
 */
export function parseFilterKey(rawKey: string): {
  field: string;
  operator: FilterOperator;
  hadSuffix: boolean;
} {
  const delimiterIndex = rawKey.indexOf(FILTER_DELIMITER);
  if (delimiterIndex < 0) {
    return { field: rawKey, operator: 'eq', hadSuffix: false };
  }
  const field = rawKey.slice(0, delimiterIndex);
  const opString = rawKey.slice(delimiterIndex + FILTER_DELIMITER.length);
  if (!KNOWN_OPERATORS.has(opString as FilterOperator)) {
    throw new Error(
      `unknown operator "${opString}" in key "${rawKey}". ` +
        `Known operators: ${[...KNOWN_OPERATORS].join(', ')}.`,
    );
  }
  return { field, operator: opString as FilterOperator, hadSuffix: true };
}

/**
 * Renders a single filter operator to a SQL fragment. `pushParam` is a
 * caller-supplied callback that pushes a value into the caller's own params
 * array and returns the placeholder text — the write side casts it
 * (`$n::TYPE`/`$n::TYPE[]`, choosing the array form itself since it already
 * has `operator` in scope), the read side doesn't need to cast at all.
 * `isNull`/`isNotNull` never call `pushParam`: no parameter is bound.
 */
export function buildFilterClause(
  column: string,
  operator: FilterOperator,
  value: unknown,
  pushParam: (value: unknown) => string,
): string {
  switch (operator) {
    case 'eq':
      return value === null ? `${column} IS NULL` : `${column} = ${pushParam(value)}`;
    case 'contains':
      return `${column} ILIKE ${pushParam(`%${String(value)}%`)}`;
    case 'in':
      return `${column} = ANY(${pushParam(value)})`;
    case 'notIn':
      return `(${column} <> ALL(${pushParam(value)}) OR ${column} IS NULL)`;
    case 'gt':
      return `${column} > ${pushParam(value)}`;
    case 'gte':
      return `${column} >= ${pushParam(value)}`;
    case 'lt':
      return `${column} < ${pushParam(value)}`;
    case 'lte':
      return `${column} <= ${pushParam(value)}`;
    case 'isNull':
      return value === false ? `${column} IS NOT NULL` : `${column} IS NULL`;
    case 'isNotNull':
      return value === false ? `${column} IS NULL` : `${column} IS NOT NULL`;
    default: {
      const exhaustive: never = operator;
      throw new Error(`Unhandled filter operator: ${String(exhaustive)}`);
    }
  }
}

/**
 * Maps `information_schema.columns.data_type` (or `udt_name` for arrays)
 * to the Postgres type name used for explicit parameter casting
 * (`$1::UUID`, `$2::JSONB`, etc.). Unknown types fall back to `TEXT`.
 */
export function mapPostgresType(dataType: string | undefined): string {
  if (!dataType) return 'TEXT';
  switch (dataType) {
    case 'uuid':
      return 'UUID';
    case 'integer':
    case 'smallint':
    case 'bigint':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp without time zone':
    case 'timestamp with time zone':
    case 'timestamptz':
      return 'TIMESTAMPTZ';
    case 'date':
      return 'DATE';
    case 'numeric':
    case 'real':
    case 'double precision':
      return 'NUMERIC';
    case 'json':
      return 'JSON';
    case 'jsonb':
      return 'JSONB';
    case 'text':
    case 'character varying':
      return 'TEXT';
    case 'bytea':
      return 'BYTEA';
    case '_uuid':
      return 'UUID[]';
    case '_int4':
      return 'INTEGER[]';
    case '_text':
    case '_varchar':
      return 'TEXT[]';
    default:
      return 'TEXT';
  }
}

/**
 * Builds a parameterised `WHERE` clause from a `FilterQuery`. Bare keys emit
 * `col = $n::TYPE` (or `col = ANY($n::TYPE[])` for an array value, as sugar
 * for `col__in`); a literal `null` emits `col IS NULL` with no parameter.
 * Suffixed keys (`col__lt`, `col__in`, `col__isNull`, etc.) dispatch through
 * the same operator vocabulary as the read-side `SqlQueryBuilder`.
 *
 * `startIndex` is the placeholder offset — pass the number of params
 * already consumed upstream (e.g. by a SET clause in UPDATE). Read-side
 * callers pass `0`.
 */
export function buildWhere<T>(
  filters: FilterQuery<T>,
  types: ColumnTypeMap,
  startIndex = 0,
): { sql: string; values: unknown[] } {
  const entries = Object.entries(filters as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('WHERE clause requires at least one filter');
  }

  const values: unknown[] = [];
  const clauses = entries.map(([rawKey, rawValue]) => {
    const { field, operator: parsedOperator } = parseFilterKey(rawKey);
    const operator = parsedOperator === 'eq' && Array.isArray(rawValue) ? 'in' : parsedOperator;
    const isArrayOperator = operator === 'in' || operator === 'notIn';

    return buildFilterClause(field, operator, rawValue, (value) => {
      const pgType = mapPostgresType(types[field]);
      values.push(value);
      const idx = startIndex + values.length;
      return isArrayOperator ? `$${idx}::${pgType}[]` : `$${idx}::${pgType}`;
    });
  });

  return { sql: clauses.join(' AND '), values };
}

/**
 * Assembles a parameterised `SELECT` statement for the shared read path
 * (used by both `PgWriteDbAdapter.find*` and `PgReadDbAdapter.select`).
 */
export async function runSelect<T>(
  db: Database,
  opts: SelectOptions<T>,
  types: ColumnTypeMap,
  flags: { forUpdate: boolean; trx?: DatabaseTransaction | undefined },
): Promise<DatabaseResult> {
  const columns = opts.columns?.length ? opts.columns.join(', ') : '*';
  let sql = `SELECT ${columns} FROM ${opts.table}`;

  const values: unknown[] = [];
  if (opts.where && Object.keys(opts.where).length > 0) {
    const where = buildWhere(opts.where, types);
    values.push(...where.values);
    sql += ` WHERE ${where.sql}`;
  }

  if (opts.orderBy?.length) {
    const orderClauses = opts.orderBy.map((o) => `${o.column} ${o.direction.toUpperCase()}`);
    sql += ` ORDER BY ${orderClauses.join(', ')}`;
  }

  if (opts.limit !== undefined) {
    sql += ` LIMIT ${opts.limit}`;
  }

  if (flags.forUpdate) {
    sql += ' FOR UPDATE';
  }

  return db.query(sql, values, flags.trx);
}

const INFO_SCHEMA_SQL = `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
       WHERE table_name = $1`;

/**
 * Caches column types per table across the life of a process. Shared by
 * `PgWriteDbAdapter` and `PgReadDbAdapter` so a given table's metadata is
 * fetched at most once, regardless of which adapter gets there first.
 */
export class PgColumnTypeCache {
  private readonly cache = new Map<string, ColumnTypeMap>();

  constructor(private readonly db: Database) {}

  async get(table: string): Promise<ColumnTypeMap> {
    const cached = this.cache.get(table);
    if (cached) return cached;

    const result = await this.db.query(INFO_SCHEMA_SQL, [table]);
    const types: ColumnTypeMap = {};
    for (const row of result.rows) {
      const name = String(row.column_name);
      const dataType = String(row.data_type);
      const udtName = String(row.udt_name);
      types[name] = dataType === 'ARRAY' ? udtName : dataType;
    }

    this.cache.set(table, types);
    return types;
  }
}
