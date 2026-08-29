---
"@quilla-be-kit/persistence": minor
---

`FilterQuery<T>` and the Postgres write adapters (`update`/`delete`/`exists`/`find`/`findForUpdate`) now support the full operator-suffix DSL previously exclusive to the read-side `SqlQueryBuilder`: `__contains`, `__in`, `__notIn`, `__gt`, `__gte`, `__lt`, `__lte`, `__isNull`, `__isNotNull`, alongside the existing bare-key equality/array-membership shorthand (unchanged). This enables locked, range-filtered reads (e.g. `findManyForUpdate({ status: 'PENDING', expiresAt__lt: new Date() }, trx)`) without hand-written SQL.

**Behavior change:** passing a literal `null` for a bare filter key (e.g. `{ status: null }`) now correctly emits `status IS NULL` instead of `status = $1` with a `null` parameter — the latter never matched in Postgres (`NULL` comparisons are unknown, not true). Any caller relying on the old no-op behavior will now see rows filtered as originally intended.
