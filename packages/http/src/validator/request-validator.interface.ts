import type { ValidationResult } from './validation-result.type.js';

export type SchemaDescription = {
  readonly keys: readonly string[];
};

export interface RequestValidator {
  validate(schema: unknown, input: unknown): ValidationResult;
  /**
   * Optional schema introspection. When implemented, `@ValidateRequest`
   * uses it to inject auth-derived fields (`scopeId`, `userId`) from the
   * `ExecutionContext`, and the reserved `updatedAt` field from the
   * `If-Match` header, into the validated input **only when the schema
   * declares them**.
   *
   * Return `null` (or leave unimplemented) when the wrapped validator
   * can't enumerate top-level field names — auth-injection is skipped in
   * that case (fail-safe: no surprise fields written into schemas that
   * didn't ask for them).
   *
   * Zod example:
   *
   * ```ts
   * describeSchema(schema) {
   *   if (schema instanceof z.ZodObject) return { keys: Object.keys(schema.shape) };
   *   if (schema instanceof z.ZodEffects) return this.describeSchema(schema._def.schema);
   *   return null;
   * }
   * ```
   */
  describeSchema?(schema: unknown): SchemaDescription | null;
}
