---
"@quilla-be-kit/persistence": patch
---

Documents a migration gotcha introduced by 2.1.0's `FilterQuery<T>` widening: because `FilterQuery<T>` is now an intersection of several mapped types, TypeScript can't verify `Partial<T>` against `FilterQuery<T>` when `T` is an unresolved generic parameter (it still works fine for a concrete row type). A generic base repository/DAO method that builds a `Partial<TRow>` and passes it where `FilterQuery<TRow>` is expected will fail to compile after upgrading. Cast directly to `FilterQuery<TRow>` instead of routing through `Partial<TRow>` first — see the new "Migration note" in the README's "Filtering on write DAOs" section.
