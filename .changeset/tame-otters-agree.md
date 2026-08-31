---
"@quilla-be-kit/persistence": major
---

`BaseWriteDao.delete()` / `WriteDbAdapter.delete()` now support optimistic locking, mirroring `update()`'s existing `optimisticLock: { column, expected }` contract. Previously a `DELETE` had no compare-and-swap protection even when the caller held the row's known `updated_at` — a concurrent modification could be silently clobbered by an unconditional delete.

**Breaking:** `BaseWriteDao.delete()` and `BaseBasicRepository.delete()` change signature from `delete(id: string, trx?)` to `delete(row: { id: string; updated_at?: Date }, trx?)`, so the expected `updated_at` can be passed alongside the id. Update call sites from `delete(id, trx)` to `delete({ id }, trx)` (add `updated_at` to opt into the lock). `deleteMany()` is unchanged — no per-row lock, same rationale as `updateMany()`.

`WriteDbAdapter.delete()`'s `DeleteOptions<T>` gains an optional `optimisticLock?: { column, expected }` field. `PgWriteDbAdapter.delete()` appends the same `AND <column> = date_trunc('milliseconds', $N::timestamptz)` clause `update()` uses, and `BaseWriteDao.delete()` throws `OptimisticLockError` when `updated_at` was provided and the delete matched zero rows.

`BaseAggregateRepository.delete(aggregate, ctx)` now opportunistically threads `aggregate.updatedAt` through as the lock — the value already round-tripped onto the aggregate when it was loaded, so aggregate deletes get CAS protection with no change needed above the repository layer.
