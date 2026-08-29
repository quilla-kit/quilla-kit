import { describe, expect, it } from 'vitest';
import { type ColumnTypeMap, buildWhere } from '../../src/postgres/pg-sql.js';

const types: ColumnTypeMap = {
  id: 'uuid',
  status: 'text',
  expires_at: 'timestamp with time zone',
  amount: 'integer',
  deleted_at: 'timestamp with time zone',
};

describe('buildWhere', () => {
  it('emits equality for a bare key', () => {
    const { sql, values } = buildWhere({ id: 'u1' }, types);
    expect(sql).toBe('id = $1::UUID');
    expect(values).toEqual(['u1']);
  });

  it('emits = ANY(...) for a bare array value (in shorthand)', () => {
    const { sql, values } = buildWhere({ id: ['u1', 'u2'] }, types);
    expect(sql).toBe('id = ANY($1::UUID[])');
    expect(values).toEqual([['u1', 'u2']]);
  });

  it('emits IS NULL for a literal null with no parameter (bug fix)', () => {
    const { sql, values } = buildWhere({ status: null }, types);
    expect(sql).toBe('status IS NULL');
    expect(values).toEqual([]);
  });

  it('supports __contains as ILIKE', () => {
    const { sql, values } = buildWhere({ status__contains: 'PEND' }, types);
    expect(sql).toBe('status ILIKE $1::TEXT');
    expect(values).toEqual(['%PEND%']);
  });

  it('supports __in', () => {
    const { sql, values } = buildWhere({ status__in: ['PENDING', 'ACTIVE'] }, types);
    expect(sql).toBe('status = ANY($1::TEXT[])');
    expect(values).toEqual([['PENDING', 'ACTIVE']]);
  });

  it('supports __notIn, including rows with a NULL', () => {
    const { sql, values } = buildWhere({ status__notIn: ['DONE'] }, types);
    expect(sql).toBe('(status <> ALL($1::TEXT[]) OR status IS NULL)');
    expect(values).toEqual([['DONE']]);
  });

  it('supports __gt/__gte/__lt/__lte with a Date value', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const { sql, values } = buildWhere({ expires_at__lt: now }, types);
    expect(sql).toBe('expires_at < $1::TIMESTAMPTZ');
    expect(values).toEqual([now]);
  });

  it('supports __gte/__lte with a number value', () => {
    const { sql, values } = buildWhere({ amount__gte: 10 }, types);
    expect(sql).toBe('amount >= $1::INTEGER');
    expect(values).toEqual([10]);
  });

  it('supports __isNull with true and false, pushing no parameter', () => {
    const truthy = buildWhere({ deleted_at__isNull: true }, types);
    expect(truthy.sql).toBe('deleted_at IS NULL');
    expect(truthy.values).toEqual([]);

    const falsy = buildWhere({ deleted_at__isNull: false }, types);
    expect(falsy.sql).toBe('deleted_at IS NOT NULL');
    expect(falsy.values).toEqual([]);
  });

  it('supports __isNotNull with true and false, pushing no parameter', () => {
    const truthy = buildWhere({ deleted_at__isNotNull: true }, types);
    expect(truthy.sql).toBe('deleted_at IS NOT NULL');
    expect(truthy.values).toEqual([]);

    const falsy = buildWhere({ deleted_at__isNotNull: false }, types);
    expect(falsy.sql).toBe('deleted_at IS NULL');
    expect(falsy.values).toEqual([]);
  });

  it('throws on an unknown operator suffix', () => {
    expect(() => buildWhere({ status__smells: 'x' }, types)).toThrow(/unknown operator/);
  });

  it('throws when no filters are given', () => {
    expect(() => buildWhere({}, types)).toThrow(/at least one filter/);
  });

  it('keeps correct placeholder indices when mixing param-emitting and non-emitting operators', () => {
    const { sql, values } = buildWhere(
      { status: 'PENDING', deleted_at__isNull: true, amount__gte: 5 },
      types,
    );
    expect(sql).toBe('status = $1::TEXT AND deleted_at IS NULL AND amount >= $2::INTEGER');
    expect(values).toEqual(['PENDING', 5]);
  });

  it('offsets placeholder indices by startIndex (e.g. after a preceding SET clause)', () => {
    const { sql, values } = buildWhere({ id: 'u1' }, types, 2);
    expect(sql).toBe('id = $3::UUID');
    expect(values).toEqual(['u1']);
  });

  it('reproduces the locked, range-filtered sweep-job predicate', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const { sql, values } = buildWhere({ status: 'PENDING', expires_at__lt: now }, types);
    expect(sql).toBe('status = $1::TEXT AND expires_at < $2::TIMESTAMPTZ');
    expect(values).toEqual(['PENDING', now]);
  });
});
