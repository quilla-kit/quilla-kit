import { describe, it } from 'vitest';
import type { FilterQuery } from '../../src/db-adapter/filter-query.type.js';

type Row = {
  id: string;
  status: string;
  expiresAt: Date;
  count: number;
};

describe('FilterQuery<T> operator gating (compile-time)', () => {
  it('accepts operator-suffixed keys matched to their field kind', () => {
    const ok: FilterQuery<Row> = {
      status: 'PENDING',
      expiresAt__lt: new Date(),
      count__gte: 1,
      status__contains: 'PEND',
      status__in: ['PENDING', 'ACTIVE'],
      id__isNull: false,
    };
    void ok;
  });

  it('rejects comparison operators on non-comparable fields', () => {
    // @ts-expect-error - __lt is not valid on a string field
    const bad: FilterQuery<Row> = { status__lt: 'PENDING' };
    void bad;
  });

  it('rejects __contains on a non-string field', () => {
    // @ts-expect-error - __contains is not valid on a Date field
    const bad: FilterQuery<Row> = { expiresAt__contains: 'x' };
    void bad;
  });

  it('rejects an unknown operator suffix', () => {
    // @ts-expect-error - __smells is not a known operator
    const bad: FilterQuery<Row> = { status__smells: 'x' };
    void bad;
  });
});
