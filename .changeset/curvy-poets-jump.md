---
'@quilla-be-kit/persistence': major
---

`BaseAggregateRepository.delete()` now takes an explicit `expectedUpdatedAt: Date` parameter (positioned between `aggregate` and `ctx`) for the optimistic-lock comparison, instead of always deriving it from `aggregate.updatedAt`.

**Breaking:** update all `delete()` call sites from `repo.delete(aggregate, ctx)` to `repo.delete(aggregate, expectedUpdatedAt, ctx)`. In the common case, pass `aggregate.updatedAt` (the value read under `loadForUpdate`) to reproduce prior behavior. This removes the need to mutate an aggregate's `updatedAt` in memory as a side channel when a caller-claimed version (rather than the freshly loaded one) needs to be checked at delete time.
