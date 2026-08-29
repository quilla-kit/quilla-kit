# @quilla-be-kit/persistence

Persistence primitives: `Database` abstraction, `ReadDbAdapter` /
`WriteDbAdapter` for CQRS-isolated dialect adapters, DAOs with audit
injection and optimistic locking, aggregate repositories with scope
isolation, and a `UnitOfWork` with pluggable outbox.

Ships a **Postgres reference implementation** under
`@quilla-be-kit/persistence/postgres` — `PgDatabase`, `PgTransaction`,
`PgWriteDbAdapter` (with info-schema cache + JSONB / UUID / timestamp
casts), `PgReadDbAdapter`. Works with the `pg` package (optional peer dep).

Peer deps: `@quilla-be-kit/ddd`, `@quilla-be-kit/execution-context`,
`@quilla-be-kit/errors`. `pg` is an optional peer — required only if you
import from `/postgres`.

## Install

```sh
# Core:
pnpm add @quilla-be-kit/persistence @quilla-be-kit/ddd @quilla-be-kit/execution-context @quilla-be-kit/errors

# Plus Postgres adapter:
pnpm add pg
```

## Architectural invariants

- **Scope isolation is repo-layer explicit.** `BaseScopedAggregateRepository`
  takes `scopeId` on every load and throws `CrossScopeAccessError` on miss
  or mismatch. DAOs never inject `scope_id` implicitly.
- **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by`
  resolve from `ExecutionContextProvider.getContext().session?.userId` on
  every write. Callers cannot pass them; rows with audit fields in them
  get stripped. Writes under system contexts (no session) persist
  `null` audit.
- **Optimistic locking is opt-in via `updated_at`.** Include `updated_at`
  in the row passed to `update()` and the DAO asserts `rowCount === 1` —
  mismatch throws `OptimisticLockError`. Omit to update unconditionally.
- **Outbox is orthogonal, not built-in.** Wire an `OutboxWriter` on
  `UnitOfWork` to drain aggregate events + registered integration events
  in the same transaction. Omit for apps that don't use outbox.
- **Nested `transaction()` calls JOIN** — inner call sees the outer
  `UnitOfWorkContext` (via AsyncLocalStorage) and reuses the trx.
- **CQRS isolation at the type level.** `ReadDbAdapter` exposes only
  `select`; `WriteDbAdapter` exposes `insert`/`update`/`delete`/`find`/
  `findForUpdate`/`exists`. A single physical class can implement both
  interfaces for wiring convenience, but DAO-facing types enforce the
  boundary. **Read DAOs never accept a `trx` parameter** — reads don't
  participate in write transactions.
- **Pre-create uniqueness checks use the write side's unlocked reads**
  (`findOne` / `existsBy` on `BaseWriteDao`), not the read side. Locked
  reads (`findOneForUpdate`) are for read-before-update only.

## Vocabulary

- **DAO** layer — verb `find*`. Returns raw `TRow` from the database.
- **Repository** layer — verb `load*`. Returns `TAggregate` mapped from
  rows. The verb split marks the layer.

## Minimal usage (with Postgres)

```ts
import {
  BasePersistenceMapper,
  BaseScopedAggregateRepository,
  BaseWriteDao,
  UnitOfWork,
} from '@quilla-be-kit/persistence';
import {
  PgDatabase,
  PgReadDbAdapter,
  PgWriteDbAdapter,
} from '@quilla-be-kit/persistence/postgres';

// 1. Write DAO for your row shape:
class UserDao extends BaseWriteDao<UserRow> {
  protected readonly tableName = 'users';
}

// 2. Mapper — extend BasePersistenceMapper for automatic column conversion:
class UserMapper extends BasePersistenceMapper<User, UserProps, UserRow> {
  protected createDomain(props: UserProps, id: string) {
    return User.reconstitute(props, id);
  }
}

// 3. Scoped repository:
class UserRepository extends BaseScopedAggregateRepository<User, UserRow> {}

// 4. Wire at composition root:
const db = new PgDatabase({ host, database, user, password });
// Or, to share the pool with PgLocalOutbox / PgEventBus — see "Sharing a Pool" below.
const writeAdapter = new PgWriteDbAdapter(db);
const readAdapter  = new PgReadDbAdapter(db);
const uow = new UnitOfWork({ db, outboxWriter });

const userDao  = new UserDao(writeAdapter, contextProvider);
const userRepo = new UserRepository(new UserMapper(), userDao);

// 5. Use:
await uow.transaction(async (ctx) => {
  const user = await userRepo.loadForUpdateByIdAndScopeOrFail(
    userId, scopeId, ctx,
  );
  user.changeName('Alice');
  await userRepo.update(user, ctx);
  // Domain events drained to outbox, trx committed atomically.
});

// Pre-create uniqueness check — unlocked read on the write side:
await uow.transaction(async (ctx) => {
  if (await userDao.existsBy({ email: input.email }, ctx.trx)) {
    throw new DuplicateEmailError({ email: input.email });
  }
  await userRepo.create(newUser, ctx);
});

// Read-side projections — one DAO exposes many query methods, each
// building its own SQL via `this.qb<T>()`. See "Read-side queries" below
// for the full flow (builder, column resolver, HTTP query schema).
class UserReadDao extends BaseReadDao {
  listActive(scopeId: string) {
    const q = this.qb<UserListRow>()
      .select(['id', 'name', 'createdAt'])
      .from('users')
      .filters({ scopeId, isActive: true })
      .orderBy([{ createdAt: 'desc' }])
      .build();
    return this.findMany<UserListRow>(q);
  }
}
const userReadDao = new UserReadDao({
  adapter: readAdapter,
  builderFactory: (r) => new PgSqlQueryBuilder(r),
});
const rows = await userReadDao.listActive(scopeId); // no ctx, no trx

// Pool lifecycle: register with @quilla-be-kit/runtime:
shutdown.addPhase({
  name: 'database',
  participants: [{ name: 'PgDatabase', dispose: () => db.disconnect() }],
});
```

### Sharing a Pool

`PgDatabase` accepts either a `PoolConfig` (the adapter creates and owns
the pool) or `{ pool }` (the caller owns it — use this when the same
physical Postgres connection pool needs to back other adapters like
`PgLocalOutbox` / `PgEventBus` from `@quilla-be-kit/messaging`):

```ts
import { Pool } from 'pg';
import { PgDatabase } from '@quilla-be-kit/persistence/postgres';
import { PgLocalOutbox, PgEventBus } from '@quilla-be-kit/messaging/postgres';

// Adapter-owned pool — disconnect() ends it:
const db = new PgDatabase({ connectionString: process.env.DATABASE_URL });

// Caller-owned pool — shared with the messaging adapters:
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PgDatabase({ pool });
const outbox = new PgLocalOutbox({ pool });
const bus = new PgEventBus({ pool });

// When the pool is caller-owned, db.disconnect() is a no-op.
// Register pool.end() on your ShutdownManager yourself:
shutdown.addPhase({
  name: 'database',
  participants: [{ name: 'pg.Pool', dispose: () => pool.end() }],
});
```

### Handling optimistic lock conflicts

When an update includes `updated_at` in the input row, the DAO asserts
`rowCount === 1` and throws `OptimisticLockError` (extends `ConflictError`
from `@quilla-be-kit/errors`) on a mismatch. Catch it at the command handler
boundary and retry or surface a 409 to the client:

```ts
import { OptimisticLockError } from '@quilla-be-kit/persistence';

try {
  await uow.transaction(async (ctx) => {
    const user = await userRepo.loadForUpdateByIdOrFail(userId, ctx);
    user.changeName(newName);
    await userRepo.update(user, ctx);
  });
} catch (err) {
  if (err instanceof OptimisticLockError) {
    // someone else updated this row — retry, or surface 409 CONFLICT
  }
  throw err;
}
```

### Filtering on write DAOs

`WriteDbAdapter`'s `where` option (used by `BaseWriteDao`'s `findOne` /
`findMany` / `findOneForUpdate` / `findManyForUpdate` / `update` / `delete` /
`exists`) accepts the same operator-suffix DSL as the read-side
`SqlQueryBuilder` — see [The filter suffix DSL](#the-filter-suffix-dsl) below
for the full operator table. Two differences from the read side:

- Keys are **raw DB column names** (`expires_at__lt`), not the camelCase,
  `ColumnResolver`-resolved names `SqlQueryBuilder` uses — write DAOs have no
  resolver.
- A `bigint`/`numeric` column typed as `string` in your row type (common,
  to avoid JS float-precision loss) won't get `__gt/__gte/__lt/__lte` —
  those are only available where TypeScript can see `number | Date`.

This is what makes a locked, range-filtered sweep read possible without
hand-written SQL:

```ts
await uow.transaction(async (ctx) => {
  const pending = await replacementDao.findManyForUpdate(
    { status: 'PENDING', expiresAt__lt: new Date() },
    ctx.trx,
  );
  for (const row of pending) {
    // transition each row in the same locked transaction
  }
});
```

**Behavior note:** a literal `null` for a bare key (`{ status: null }`) emits
`status IS NULL`, not `status = $1` with a `null` parameter — the latter
never matches in Postgres.

**Sharp edge — `__notIn` on `delete`/`update`:** `field__notIn` compiles to
`(field <> ALL($n) OR field IS NULL)`, matching the read side's null-safe
`NOT IN` semantics. On a destructive write, this also matches rows where
`field IS NULL`: `delete({ status__notIn: ['DONE'] })` deletes every row with
`status IS NULL` too, not just rows with some other non-`DONE` status. Confirm
that's actually intended before using `__notIn` in a `delete` or `update`.

**Migration note — casting to `FilterQuery<T>` inside a generic method:**
`FilterQuery<T>` is now an intersection of several mapped types (the base
shape plus one per operator group). TypeScript can verify `Partial<Row>`
against `FilterQuery<Row>` for a *concrete* `Row`, but it can't verify
`Partial<T>` against `FilterQuery<T>` when `T` is still an unresolved generic
parameter — even though every added property is optional. If you have a
generic base repository/DAO method that builds a `Partial<TRow>` and passes
it somewhere typed `FilterQuery<TRow>`, that assignment will now fail to
compile. Cast directly to `FilterQuery<TRow>` instead of routing through
`Partial<TRow>` first — e.g. `{ id } as FilterQuery<TRow>`, not
`{ id } as Partial<TRow>` — which sidesteps the generic-assignability gap
entirely (this is the pattern `BaseWriteDao` uses internally).

## Mappers — row ↔ aggregate conversion

`BasePersistenceMapper` handles the bidirectional row↔aggregate conversion
with **no explicit column list**. It uses prototype reflection on the
aggregate to discover persisted properties, then converts names between
`camelCase` (domain) and `snake_case` (DB) automatically.

### The contract your aggregate must follow

For a domain property to be persisted, the aggregate must expose both a
getter and a setter for it on the class prototype:

```ts
class Tenant extends AggregateRoot<TenantProps> {
  // Persisted — private setter + public getter pair:
  private set name(v: string) { this.props.name = v; }
  get name(): string { return this.props.name; }

  private set country(v: string) { this.props.country = v; }
  get country(): string { return this.props.country; }

  // Computed — getter only; mapper ignores it:
  get displayName(): string { return `${this.name} (${this.country})`; }
}
```

Why setters? The mapper distinguishes **persisted** properties from
**computed** ones by checking whether a setter exists. `private` is the
right visibility — only the aggregate itself should mutate state; external
callers use intention-revealing methods (`tenant.changeName('NewName')`)
that internally assign `this.name = 'NewName'`, which routes through the
private setter.

Setters are also where **structural invariants** live (non-empty strings,
non-null required fields) — guards that must hold after rehydration from
the DB, not just after a command. See
[mutation patterns in `@quilla-be-kit/ddd`](../ddd/README.md#mutation-patterns)
for the full command-side idiom (`updateFromInput`, `changeX`, domain
methods) and how structural vs. business invariants split between setters
and mutation methods.

### Mapper — minimum boilerplate case (pure snake_case)

When every domain property name maps cleanly to its snake_case column
(e.g. `adminEmail` ↔ `admin_email`), the mapper is just one method:

```ts
import { BasePersistenceMapper } from '@quilla-be-kit/persistence';

class TenantMapper extends BasePersistenceMapper<Tenant, TenantProps, TenantRow> {
  protected createDomain(props: TenantProps, id: string): Tenant {
    return Tenant.reconstitute(props, id);
  }
}
```

That's it. The base iterates every `get`+`set` accessor pair on `Tenant`'s
prototype chain (including inherited `createdAt` / `updatedAt` /
`insertedBy` / `updatedBy` from `Entity`), converts each name to
snake_case, and reads values via the getter.

`createDomain` calls `Tenant.reconstitute(props, id)` — the rehydration
factory that skips validation and emits no domain events (contrasted
with `Tenant.create(...)`, the new-aggregate factory). See
[construction patterns in `@quilla-be-kit/ddd`](../ddd/README.md#construction-patterns)
for why these are two separate factories and what each is responsible for.

### Mapper — with overrides + value-object serialization (User)

When some columns don't follow the convention, and some properties wrap
value objects that need scalar serialization:

```ts
class UserMapper extends BasePersistenceMapper<User, UserProps, UserRow> {
  // Only declare the odd-ones-out:
  protected readonly columnOverrides = {
    password: 'password_hash',
    resetPasswordTokenExpiresAt: 'reset_password_token_expiration',
  } as const;

  protected createDomain(props: UserProps, id: string): User {
    return User.reconstitute({
      ...props,
      // Wrap scalar → value object on the way in:
      password: Password.fromHashedValue(props.password as string),
      userType: UserTypeFactory.create(props.userType as string),
    }, id);
  }

  // Serialize value objects on the way out. Merged OVER the default
  // prototype-reflected row (last-write-wins):
  protected createPersistence(user: User): Partial<UserRow> {
    return {
      password_hash: user.password.getHashedValue(),
      user_type: user.userType.toString(),
    };
  }
}
```

### What `BasePersistenceMapper` handles for you

- **`id`** — read from `aggregate.id`, written to the `id` column.
- **`createdAt` / `updatedAt` / `insertedBy` / `updatedBy`** — inherited
  accessors on `Entity` are auto-discovered and mapped to their snake_case
  columns. You never declare them.
- **Every persisted domain property** — discovered via prototype reflection
  (any accessor with both `get` and `set`).
- **Column name resolution** — `columnOverrides[domainKey]` wins; otherwise
  defaults to `camelToSnake(domainKey)`.
- **Reverse lookup** on `toDomain` — inverts `columnOverrides` first, then
  falls back to `snakeToCamel(column)`.

### What `BasePersistenceMapper` does *not* do

- **Value object serialization** — a `Password` in `props` stays a
  `Password` on the output row unless `createPersistence` overrides the
  specific column with its scalar form.
- **Skip computed getters** — getters without setters are excluded
  automatically; no explicit opt-out needed.

### Caveats to be aware of

- Relies on **class prototype** accessors, not instance own-properties.
  Fine for idiomatic TypeScript class syntax (`get name() { ... }`).
- **Minification** can rename getter/setter identifiers in the consumer's
  backend build, which would break reflection. Standard Node.js backends
  don't minify TypeScript output — a non-issue unless you're deliberately
  minifying your class names. If that's your pipeline, implement
  `PersistenceMapper` directly instead of extending `BasePersistenceMapper`.

## Read-side queries

The read side is **projection-driven, not table-driven**. A single read DAO exposes as many query methods as the module needs, each building its own SQL — possibly over different tables, joins, aggregates, or views. There is no one-table-per-DAO rule.

Three pieces cooperate:

| Piece | Role |
| --- | --- |
| `SqlQueryBuilder<T>` | Fluent SQL builder. `.select / .from / .join / .groupBy / .where / .filters / .orderBy / .paginate / .build`. Immutable — each fluent call returns a new instance. |
| `ColumnResolver` | Translates domain vocabulary (camelCase, `scopeId`) to DB columns (snake_case, `tenant_id`) at build time. |
| `BaseReadDao` | Owns the resolver + builder factory. Exposes `qb<T>()`, `findOne<T>(q)`, `findMany<T>(q)`, `findPaginated<T>(q, page)`. |

And one optional add-on for HTTP controllers:

| Piece | Role |
| --- | --- |
| `createQueryParametersSchema` (`/query-schema`) | Zod-based: takes a base filter shape, generates a full validation + transform schema that parses `?name__contains=foo&createdAt__gte=...&sort=...&page=2` into a typed `StandardListQuery<TFilters>`. Opt-in sub-path with `zod` as optional peer. |

### A read DAO with two query methods

```ts
import { BaseReadDao, type PaginatedResult, type StandardListQuery } from '@quilla-be-kit/persistence';
import { PgSqlQueryBuilder } from '@quilla-be-kit/persistence/postgres';

type RoleDetailsReadModel = {
  id: string;
  name: string;
  description: string | null;
  permissions: readonly string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type RoleListReadModel = Pick<RoleDetailsReadModel, 'id' | 'name' | 'isActive' | 'createdAt'>;

type RoleListQuery = StandardListQuery<{
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
}>;

export class RoleReadDao extends BaseReadDao {
  getDetails(id: string, scopeId: string): Promise<RoleDetailsReadModel | null> {
    const q = this.qb<RoleDetailsReadModel>()
      .select(['id', 'name', 'description', 'permissions', 'isActive', 'createdAt', 'updatedAt'])
      .from('iam_roles')
      .filters({ id, scopeId })
      .build();
    return this.findOne<RoleDetailsReadModel>(q);
  }

  listPage(query: RoleListQuery, scopeId: string): Promise<PaginatedResult<RoleListReadModel>> {
    const page = query.pagination ?? { page: 1, pageSize: 20 };
    const q = this.qb<RoleListReadModel>()
      .select(['id', 'name', 'isActive', 'createdAt'])
      .from('iam_roles')
      .filters({ ...query.filters, scopeId })
      .orderBy(query.sort, {
        enforced: [{ scopeId: 'asc' }],
        defaults: [{ createdAt: 'desc' }],
      })
      .paginate(page)
      .build();
    return this.findPaginated<RoleListReadModel>(q, page);
  }
}
```

Wire it at the composition root:

```ts
import { PgReadDbAdapter, PgSqlQueryBuilder } from '@quilla-be-kit/persistence/postgres';

const roleReadDao = new RoleReadDao({
  adapter: new PgReadDbAdapter(db),
  builderFactory: (resolver) => new PgSqlQueryBuilder(resolver),
});
```

### Domain vocabulary in, snake_case out

You write columns in domain vocabulary (`createdAt`, `isActive`, `scopeId`). The builder resolves them through the `ColumnResolver` and emits the correct DB names **plus output aliases** so read models receive the domain shape straight back:

```ts
this.qb().select(['id', 'createdAt', 'isActive']).from('users').build();
// -> SELECT id, created_at AS "createdAt", is_active AS "isActive" FROM users
```

The same resolver applies to `.filters()`, `.orderBy()`, and `.groupBy()`. `this.findOne` / `findMany` return rows with the camelCase keys the read model expects — no more hand-written `'created_at as "createdAt"'` lists.

### The filter suffix DSL

`.filters({ ... })` accepts a flat object keyed by `field` or `field__operator`. The delimiter is double-underscore (`__`) to avoid collisions with field names that contain underscores. The same vocabulary is also available on write DAOs' `where` filters — see [Filtering on write DAOs](#filtering-on-write-daos) above for the write-side caveats.

| Operator | SQL | Available for |
| --- | --- | --- |
| `field` (bare) | `field = $n` (or `IS NULL` if value is `null`) | all kinds |
| `field__contains` | `field ILIKE '%value%'` | string |
| `field__in` | `field = ANY($n)` | string, number, date, enum |
| `field__notIn` | `field <> ALL($n) OR field IS NULL` | string, number, date, enum |
| `field__gt` / `__gte` / `__lt` / `__lte` | `field > $n` etc. | number, date |
| `field__isNull` | `field IS NULL` (or `IS NOT NULL` if value is `false`) | all kinds |
| `field__isNotNull` | `field IS NOT NULL` (inverse of above) | all kinds |

`undefined` values are skipped, so `filters({ name: opts.name })` composes cleanly when `opts.name` is optional. Unknown operator suffixes throw at build time.

### Raw WHERE fragments for dialect-specific operators

When the suffix DSL isn't enough (JSONB containment, full-text search, custom functions), use `.where(sql, ...params)`. Positional `?` placeholders are rebased onto the builder's parameter sequence:

```ts
this.qb<TaskRow>()
  .from('tasks')
  .filters({ scopeId })
  .where('tags @> ?::jsonb', JSON.stringify(['urgent']))
  .where('assignees @> ?::jsonb', JSON.stringify([userId]))
  .build();
// -> WHERE tenant_id = $1 AND tags @> $2::jsonb AND assignees @> $3::jsonb
```

Each `.where()` call is ANDed with the rest. Never concatenate user input into the SQL string — pass it as a parameter.

### Joins

`.join(clause: string)` appends a raw JOIN clause verbatim. Call it once per join — multiple calls accumulate in declaration order:

```ts
this.qb<OrderSummaryRow>()
  .from('orders o')
  .join('LEFT JOIN customers c ON c.id = o.customer_id')
  .join('LEFT JOIN order_lines ol ON ol.order_id = o.id')
  .select(['o.id', 'o.created_at', 'c.name', 'ol.sku'])
  .filters({ 'o.scope_id': scopeId })
  .build();
```

**Column qualification.** When queries span multiple tables, qualify ambiguous column references in every builder call that touches column names — `.select()`, `.filters()`, `.where()`, `.groupBy()`, and `.orderBy()` all accept `'table.col'` expressions and pass them through without resolver lookup:

```ts
.select(['o.created_at'])           // table.col — passed through, no resolver
.select(['createdAt'])              // bare key — resolved via ColumnResolver
.select(['o.*'])                    // wildcard — passed through
.select(['COUNT(ol.id) AS "lineCount"'])  // pre-aliased expression — passed through
```

> **Qualified references are SQL space.** The builder holds one resolver — the aggregate's — so it can't sensibly keep mapping past the dot (a joined table may have its own naming or overrides). The rule is: bare `createdAt` is domain vocabulary and gets resolved; `o.createdAt` is SQL and emits `o.createdAt` verbatim, which Postgres will reject if the real column is `created_at`. Write `o.created_at` yourself once you've qualified. The asymmetry is silent at build time and surfaces only at query execution — qualify carefully.

`.from()` accepts an alias: `'orders o'` or `'orders AS o'`. Use an alias whenever you qualify columns so the alias propagates consistently through the rest of the query.

### Aggregations with GROUP BY

`.groupBy(columns: readonly string[])` adds a `GROUP BY` clause. Column keys are domain-vocabulary and resolved through the `ColumnResolver` the same way as `.select()`. Qualify with `'table.col'` when the query joins multiple tables:

```ts
this.qb<LineCountRow>()
  .from('orders o')
  .join('LEFT JOIN order_lines ol ON ol.order_id = o.id')
  .select(['o.id', 'o.created_at', 'COUNT(ol.id) AS "lineCount"'])
  .filters({ 'o.scope_id': scopeId })
  .groupBy(['o.id', 'o.created_at'])
  .build();
```

When `.paginate()` is also applied, the count wraps the grouped subquery automatically — you don't need to do anything extra.

### Pagination

`.paginate({ page, pageSize })` adds `LIMIT`/`OFFSET` and automatically emits a `countSql` alongside the data SQL. `findPaginated` runs both queries in parallel on the read pool and returns a `PaginatedResult<T>`:

```ts
const result = await dao.listPage(query, scopeId);
// { rows: [...], total: 137, page: 2, pageSize: 20 }
```

`distinctOn` is supported for Postgres:

```ts
.paginate({ page: 1, pageSize: 50, distinctOn: ['customerId'] })
// -> SELECT DISTINCT ON (customer_id) ... LIMIT 50 OFFSET 0
```

If the query uses `GROUP BY`, the count is computed over the grouped set via a subquery wrap — you don't need to do anything special.

When hand-constructing a `QueryProduct` with both `sql` and `countSql`, both queries receive the same `params` array — the caller is responsible for ensuring both are parametrically compatible.

### Sorting with enforced + default directives

`.orderBy(userSort, { enforced, defaults })` gives you three layers:

- **User sort** — from an HTTP query, or the `sort` on a `StandardListQuery`.
- **Enforced** — always applied, prepended to whatever user sort is there (use for scope-first stability, deterministic ordering across equal keys).
- **Defaults** — applied only when `userSort` is empty or absent.

```ts
.orderBy(query.sort, {
  enforced: [{ scopeId: 'asc' }],
  defaults: [{ createdAt: 'desc' }, { id: 'asc' }],
})
```

### `ColumnResolver` — mapping domain keys to your column names

Every `BaseReadDao` carries a `ColumnResolver`. The default is `DefaultColumnResolver`, which does camelCase → snake_case plus any explicit overrides you pass:

```ts
import { DefaultColumnResolver } from '@quilla-be-kit/persistence';

new DefaultColumnResolver({
  overrides: {
    scopeId: 'tenant_id',       // your column isn't called `scope_id`
    password: 'password_hash',
  },
});
```

Pass it to the DAO constructor:

```ts
new RoleReadDao({
  adapter: readAdapter,
  builderFactory: (r) => new PgSqlQueryBuilder(r),
  columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
});
```

Or, more commonly, bake the overrides into a **shell base class** once and every read DAO in your project inherits them (see the "Adopting the toolkit: build a shell" section in the root [README](../../README.md)):

```ts
export abstract class RelmoBaseReadDao extends BaseReadDao {
  constructor(adapter: ReadDbAdapter) {
    super({
      adapter,
      builderFactory: (r) => new PgSqlQueryBuilder(r),
      columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
    });
  }
}
```

Then `extends RelmoBaseReadDao` everywhere and every query translates `scopeId` → `tenant_id` automatically.

### HTTP query string → validated DTO → read DAO

The `@quilla-be-kit/persistence/query-schema` sub-path provides `createQueryParametersSchema` — a Zod helper that generates the full validation + transform schema from a plain filter shape:

```ts
// application/queries/list-roles.query.ts
import type { StandardListQuery } from '@quilla-be-kit/persistence';

export type ListRolesFilters = {
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
};
export type ListRolesQuery = StandardListQuery<ListRolesFilters>;
```

```ts
// presentation/dto/list-roles.request-dto.ts
import { z } from 'zod';
import { createQueryParametersSchema } from '@quilla-be-kit/persistence/query-schema';
import type { ListRolesFilters } from '../../application/queries/list-roles.query.js';

const filters = z.object({
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.coerce.date().optional(),
}) as z.ZodObject<{ [K in keyof ListRolesFilters]: z.ZodType<ListRolesFilters[K]> }>;

export const ListRolesRequestDto = createQueryParametersSchema<ListRolesFilters>(filters, {
  defaultPageSize: 20,
  maxPageSize: 100,
});
```

```ts
// presentation/controllers/roles.controller.ts
@Controller('/roles')
export class RolesController {
  constructor(private readonly roleRead: RoleReadDao) {}

  @Get('/')
  @ValidateRequest(ListRolesRequestDto, ['query'])
  async list(req: HttpRequest): Promise<HttpResponse> {
    const query = req.getValidatedInput<ListRolesQuery>();
    const ctx = req.getExecutionContext();
    const result = await this.roleRead.listPage(query, ctx.scopeId!);
    return HttpResponse.ok(result);
  }
}
```

A request like:

```
GET /roles?name__contains=admin&isActive=true&createdAt__gte=2026-01-01&sort=createdAt:desc&page=2&pageSize=50
```

becomes, by the time the controller's handler sees it:

```ts
{
  filters: {
    name__contains: 'admin',
    isActive: true,
    createdAt__gte: new Date('2026-01-01'),
  },
  sort: [{ createdAt: 'desc' }],
  pagination: { page: 2, pageSize: 50 },
}
```

The filter shape you declare drives the generated operator set automatically — string fields get `__contains` / `__in` / `__notIn` / `__isNull` / `__isNotNull`, numbers and dates add `__gt` / `__gte` / `__lt` / `__lte`, booleans get `__isNull` / `__isNotNull`, enum fields (`z.enum(...)`) get `__in` / `__notIn` / `__isNull` / `__isNotNull` (no `__contains` — substring match is semantically wrong for fixed-value sets). Unknown query keys are stripped. Sort directives pointing at unknown fields are dropped. `pageSize` is clamped to `maxPageSize`.

#### Strict vs tolerant parsing

By default the parser is **tolerant** — unknown keys, unknown sort fields, bad sort directions, and invalid `page` / `pageSize` values are silently normalized (dropped or replaced with defaults). That suits public HTTP endpoints where you'd rather serve a valid response with sensible defaults than 400 the caller for typos.

Opt into **strict** mode for trusted callers (internal RPC, background jobs) or when you want client bugs to surface loudly:

```ts
export const ListRolesRequestDto = createQueryParametersSchema<ListRolesFilters>(filters, {
  defaultPageSize: 20,
  maxPageSize: 100,
  strict: true,
});
```

In strict mode a request like `?unknown=x&sort=foo:sideways&page=-1` produces a single `ZodError` with one issue per problem: unknown key, unknown sort field, invalid sort direction, invalid page. `maxPageSize` stays a **clamp** even in strict mode — a client asking for more data than you're willing to serve isn't malformed input, just bounded.

#### Extra top-level fields (auth-derived identifiers, correlation ids, etc.)

Some queries need fields that belong on the **query envelope** but aren't client-narrowable filters — typically auth-derived identifiers the server populates post-validation (`scopeId`, `userId`, etc.). Putting those inside the filter shape would be wrong — the generator would auto-expand them into suffix operators (`scopeId__in`, `scopeId__contains`) and expose scope-crossing filters to the client.

Use the `extraFields` option to declare them at the top level of the generated schema instead. The generator:

- Declares them at the top level (so strict mode accepts them and doesn't reject as unknown).
- **Skips** suffix-operator expansion for their names.
- Passes them through to the transform output at the top level, alongside `filters` / `sort` / `pagination` — **not** nested under `filters`.

```ts
import { z } from 'zod';
import { createQueryParametersSchema } from '@quilla-be-kit/persistence/query-schema';

export const ListRolesRequestDto = createQueryParametersSchema<
  ListRolesFilters,
  { scopeId: string; userId: string }
>(filters, {
  strict: true,
  extraFields: z.object({
    scopeId: z.string().optional(),
    userId: z.string().optional(),
  }),
});
```

`@ValidateRequest` then populates `scopeId` / `userId` from the active `ExecutionContext` because the schema declares them — see [conditional auth-injection in `@quilla-be-kit/http`](../http/README.md#validaterequestschema-sources). Your consumer-side query type composes via intersection:

```ts
export type ListRolesQuery = StandardListQuery<ListRolesFilters> & {
  scopeId?: string;
  userId?: string;
};
```

Handler reads `query.scopeId` directly — no separate arg, no explicit stitch at the controller. The toolkit stays naming-agnostic: `scopeId` / `userId` are your choice (some apps call the boundary `tenantId`, `workspaceId`, etc.), and any field can flow through `extraFields`, not just auth identifiers.

The generator is Zod-bound (extracts field kinds by walking the `ZodObject` schema) but the output — `StandardListQuery<TFilters> & Partial<TExtra>` — is validator-agnostic. A Valibot or ArkType consumer can implement their own generator against the same output contract. Field descriptors are available via `fieldDescriptorsFromZod` for building alternative generators on top of Zod.

### Safety discipline

`.select()`, `.from()`, `.join()`, `.groupBy()`, `.orderBy()`, and `.filters()` validate identifiers with a strict regex — user input must **never** reach those seams. When you need a runtime value in a condition, it flows through `.where(sql, ?)` or `.filters({...})`, both of which parameterise. Raw user text should never be interpolated into a SQL string.

Consumer-facing consequences:

- `.from('users; invalid-sql')` throws at build time.
- `.select(['id', injectedFromUser])` throws if the user string isn't a plain identifier.
- `.where('name = ' + userInput)` — still your own bug. Always use `.where('name = ?', userInput)`.

### When to drop back to `ReadDbAdapter.select`

The builder covers the common projection shapes. For one-off reads where the builder is overkill, `ReadDbAdapter` retains its original `select({ table, where, limit, orderBy })` API for structured single-table selects, and `raw<T>(sql, params)` for anything else. Both are available on `this.adapter` inside a DAO. The builder path is the recommended default; the raw paths stay as honest escape hatches.

## Files

```
src/
├── database/     Database / DatabaseTransaction / DatabaseResult / DatabaseHealth
├── db-adapter/   FilterQuery, Read/Write DbAdapter interfaces + options
├── dao/          BaseReadDao, BaseWriteDao
├── query/        QueryProduct, PaginatedResult, StandardListQuery, FieldDescriptor,
│                 ColumnResolver + DefaultColumnResolver, SqlQueryBuilder
├── query-schema/ createQueryParametersSchema (Zod adapter — sub-path export)
├── repository/   BaseBasic/Aggregate/Scoped/Unscoped repositories + mapper
├── unit-of-work/ UnitOfWork, UnitOfWorkContext, OutboxWriter
├── errors/       CrossScopeAccessError, OptimisticLockError
└── postgres/     PgDatabase, PgTransaction, PgWriteDbAdapter, PgReadDbAdapter,
                  PgSqlQueryBuilder
```
