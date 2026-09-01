import { ValidationError } from '@quilla-be-kit/errors';
import { HttpAttributes } from '../request/http-attributes.js';
import type { HttpRequest } from '../request/http-request.interface.js';
import type { HttpResponse } from '../request/http-response.type.js';
import type { HeaderSourceMap } from '../validator/header-source.type.js';
import type { RequestSource } from '../validator/request-source.type.js';
import type { RequestValidator } from '../validator/request-validator.interface.js';
import { addRoutePatch } from './route.metadata.js';

type ControllerMethod = (this: unknown, request: HttpRequest) => Promise<HttpResponse>;

const SOURCE_READERS: Record<RequestSource, (req: HttpRequest) => object> = {
  body: (req) => {
    const body = req.getBody();
    return body !== null && typeof body === 'object' ? body : {};
  },
  params: (req) => req.getParams(),
  query: (req) => req.getQuery(),
};

// OCC is a first-class concept in this toolkit (see the persistence
// package's `expectedUpdatedAt`), so `updatedAt` gets the same reserved-key
// treatment as `scopeId`/`userId` below — sourced from `If-Match` unless a
// route overrides it via the `headers` argument.
const DEFAULT_HEADER_MAP: HeaderSourceMap = { updatedAt: 'If-Match' };

export function ValidateRequest(
  schema: unknown,
  sources: readonly RequestSource[],
  headers?: HeaderSourceMap,
) {
  return (
    originalMethod: ControllerMethod,
    context: ClassMethodDecoratorContext,
  ): ControllerMethod => {
    if (context.kind !== 'method') {
      throw new Error('@ValidateRequest can only be applied to methods');
    }

    addRoutePatch(context.metadata as Record<string | symbol, unknown>, context.name as string, {
      validation: headers ? { schema, sources, headers } : { schema, sources },
    });

    return function (this: unknown, request: HttpRequest): Promise<HttpResponse> {
      const validator = request.getAttribute<RequestValidator>(HttpAttributes.REQUEST_VALIDATOR);
      if (!validator) {
        throw new Error(
          '@ValidateRequest used but no RequestValidator was registered on the WebServer',
        );
      }

      const raw: Record<string, unknown> = {};
      for (const source of sources) {
        Object.assign(raw, SOURCE_READERS[source](request));
      }

      // Auth-derived fields (`scopeId`, `userId`) are injected only when the
      // schema declares them — keeps the decorator from writing surprise
      // fields into schemas that don't ask for them (which breaks strict
      // validation and muddies the intent). Requires the `RequestValidator`
      // to implement `describeSchema`; validators without it get fail-safe
      // no-injection.
      const description = validator.describeSchema?.(schema);
      if (description) {
        const session = request.getExecutionContext().session;
        if (session) {
          if (description.keys.includes('scopeId')) raw.scopeId = session.scopeId;
          if (description.keys.includes('userId')) raw.userId = session.userId;
        }

        // Header-derived fields are injected only when the schema declares
        // them, same rule as the session-derived fields above, and only when
        // the header is actually sent — a merely-declared but unsent header
        // must never blank out a value the source merge already produced.
        const effectiveHeaders = { ...DEFAULT_HEADER_MAP, ...headers };
        for (const [key, headerName] of Object.entries(effectiveHeaders)) {
          if (!description.keys.includes(key)) continue;
          const value = request.getHeader(headerName);
          if (value !== null) raw[key] = value;
        }
      }

      const result = validator.validate(schema, raw);
      if (!result.success) {
        throw new ValidationError({
          message: 'Request validation failed',
          context: { issues: result.error },
        });
      }

      request.setAttribute(HttpAttributes.VALIDATED_INPUT, result.data);
      return originalMethod.call(this, request);
    };
  };
}
