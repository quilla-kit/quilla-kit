import type { ExecutionContext } from '@quilla-be-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidateRequest } from '../../src/decorator/index.js';
import { HttpAttributes } from '../../src/request/http-attributes.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import { createZodRequestValidator } from '../../src/validator/zod.js';

const validator = createZodRequestValidator();

type FakeRequestInit = {
  readonly body?: unknown;
  readonly params?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly session?: { readonly scopeId: string; readonly userId: string };
};

function fakeRequest(init: FakeRequestInit = {}): HttpRequest {
  const attributes = new Map<string, unknown>();
  attributes.set(HttpAttributes.REQUEST_VALIDATOR, validator);

  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const executionContext: ExecutionContext = {
    actorType: 'user',
    correlationId: 'corr-1',
    executionAttemptId: 'attempt-1',
    ...(init.session ? { session: init.session } : {}),
  };

  return {
    getPath: () => '/',
    getMethod: () => 'POST',
    getQuery: () => ({}),
    getParams: () => init.params ?? {},
    getHeaders: () => headers,
    getHeader: (name: string) => headers[name.toLowerCase()] ?? null,
    getBody: () => init.body ?? null,
    getBinary: () => null,
    getFile: () => null,
    getFormFields: () => ({}),
    getExecutionContext: () => executionContext,
    setAttribute: <T>(key: string, value: T) => {
      attributes.set(key, value);
    },
    getAttribute: <T>(key: string) => attributes.get(key) as T | undefined,
    getValidatedInput: <T>() => attributes.get(HttpAttributes.VALIDATED_INPUT) as T,
  };
}

class Recorder {
  received: unknown;
}

describe('@ValidateRequest header-sourced injection', () => {
  it('auto-injects updatedAt from If-Match when the schema declares it, no headers arg needed', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ body: { name: 'Ada' }, headers: { 'If-Match': 'W/"abc"' } }),
    );

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'W/"abc"' });
  });

  it('leaves a body-supplied updatedAt untouched when If-Match is absent (no null-clobbering)', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(fakeRequest({ body: { name: 'Ada', updatedAt: 'from-body' } }));

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'from-body' });
  });

  it('a present If-Match header still wins over a body-supplied updatedAt', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        body: { name: 'Ada', updatedAt: 'from-body' },
        headers: { 'If-Match': 'from-header' },
      }),
    );

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'from-header' });
  });

  it('works for header-only requests with no body, like DELETE', async () => {
    const schema = z.object({ id: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'])
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 204 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ params: { id: 'widget-1' }, headers: { 'If-Match': 'v2' } }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', updatedAt: 'v2' });
  });

  it('an explicit headers map injects a non-default field', async () => {
    const schema = z.object({ id: z.string(), correlationId: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'], { correlationId: 'X-Correlation-Id' })
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ params: { id: 'widget-1' }, headers: { 'X-Correlation-Id': 'corr-9' } }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', correlationId: 'corr-9' });
  });

  it('an explicit headers map overrides the default header name for updatedAt', async () => {
    const schema = z.object({ id: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'], { updatedAt: 'X-Expected-Version' })
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        params: { id: 'widget-1' },
        headers: { 'If-Match': 'ignored', 'X-Expected-Version': 'v5' },
      }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', updatedAt: 'v5' });
  });

  it('does not affect schemas without an updatedAt key or a headers arg (no regression)', async () => {
    const schema = z.object({ scopeId: z.string(), userId: z.string(), name: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: HttpRequest): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        body: { name: 'Ada' },
        session: { scopeId: 'scope-1', userId: 'user-1' },
      }),
    );

    expect(instance.received).toEqual({ scopeId: 'scope-1', userId: 'user-1', name: 'Ada' });
  });
});
