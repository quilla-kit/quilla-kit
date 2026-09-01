import { type ZodError, type ZodType, z } from 'zod';
import type { RequestValidator, SchemaDescription } from './request-validator.interface.js';

export type ZodRequestValidatorOptions = {
  /**
   * Formats Zod's raw issue array for inclusion in the thrown
   * `ValidationError`'s `context.issues`. Defaults to passing
   * `error.issues` through verbatim.
   */
  readonly extractIssues?: (error: ZodError) => unknown[];
};

/**
 * `RequestValidator` adapter for Zod 4. Implements `describeSchema` so
 * `@ValidateRequest` can inject `scopeId` / `userId` from the active
 * `ExecutionContext`, and `updatedAt` from the `If-Match` header, into
 * payloads whose schemas declare those keys.
 *
 * Handles the two common shapes:
 *
 * - Bare `ZodObject` — keys come straight from `schema.shape`.
 * - `ZodPipe` over `ZodObject` — the shape produced by chaining
 *   `.transform(...)` onto an object (e.g. the schema returned by
 *   `createQueryParametersSchema` in `@quilla-be-kit/persistence/query-schema`).
 *   The adapter walks the pipe's input side until it reaches a
 *   `ZodObject` and enumerates that.
 *
 * Any other shape (unions, primitives, tuples) returns `null` — the
 * decorator then skips auth-injection for that schema.
 */
export function createZodRequestValidator(
  options: ZodRequestValidatorOptions = {},
): RequestValidator {
  const extractIssues = options.extractIssues ?? ((error) => error.issues);

  return {
    validate(schema, input) {
      const result = (schema as ZodType).safeParse(input);
      if (result.success) return { success: true, data: result.data };
      return { success: false, error: extractIssues(result.error) };
    },

    describeSchema(schema): SchemaDescription | null {
      let current: unknown = schema;
      // Walk `ZodPipe.in` — Zod 4's transform produces `pipe(source, transform)`,
      // and the upstream object lives at `._zod.def.in`. Keep unwrapping so
      // chained pipes (transform().refine(), etc.) are all penetrated.
      while (current instanceof z.ZodPipe) {
        current = (current as z.ZodPipe)._zod.def.in as unknown;
      }
      if (current instanceof z.ZodObject) {
        return { keys: Object.keys(current.shape) };
      }
      return null;
    },
  };
}
