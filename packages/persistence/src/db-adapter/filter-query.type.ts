type NumberOrDateKeys<T> = {
  [K in keyof T]: NonNullable<T[K]> extends number | Date ? K : never;
}[keyof T];

type StringKeys<T> = {
  [K in keyof T]: NonNullable<T[K]> extends string ? K : never;
}[keyof T];

type ComparisonFilters<T> = {
  readonly [K in NumberOrDateKeys<T> & string as
    | `${K}__gt`
    | `${K}__gte`
    | `${K}__lt`
    | `${K}__lte`]?: T[K];
};

type ContainsFilters<T> = {
  readonly [K in StringKeys<T> & string as `${K}__contains`]?: string;
};

/**
 * `__in`/`__notIn` are ungated here — available on every field regardless of
 * kind. This is a deliberate divergence from `OPERATORS_BY_KIND`
 * (`../query/field-descriptor.type.ts`), the runtime table the read-side
 * HTTP query schema (`../query-schema/zod.ts`) uses to restrict, e.g., a
 * boolean field to only `isNull`/`isNotNull`. Gating `FilterQuery<T>`
 * identically would require deriving it from a `FieldDescriptorMap` instead
 * of the bare row type `T`, which has no notion of field kind — out of
 * scope for a DB-adapter-level type. The two tables are independently
 * maintained; keep this in mind if one changes without the other.
 */
type MembershipFilters<T> = {
  readonly [K in keyof T & string as `${K}__in` | `${K}__notIn`]?: readonly T[K][];
};

type NullabilityFilters<T> = {
  readonly [K in keyof T & string as `${K}__isNull` | `${K}__isNotNull`]?: boolean;
};

export type FilterQuery<T> = {
  readonly [K in keyof T]?: T[K] | readonly T[K][];
} & ComparisonFilters<T> &
  ContainsFilters<T> &
  MembershipFilters<T> &
  NullabilityFilters<T>;
