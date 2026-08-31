import type { Logger } from '@quilla-be-kit/observability';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { DefaultErrorResolver } from '../../error/default.resolver.js';
import type { ErrorResolver } from '../../error/error-resolver.interface.js';
import { DefaultRequestDeserializer } from '../../request/default.deserializer.js';
import { DefaultResponseSerializer } from '../../request/default.serializer.js';
import { HttpAttributes } from '../../request/http-attributes.js';
import type { NormalizedRoute } from '../../router/normalized-route.type.js';
import type { Router } from '../../router/router.js';
import type { CorsOptions } from '../../server/cors.type.js';
import type { HttpConventions } from '../../server/http-conventions.type.js';
import type { WebServer } from '../../server/web-server.interface.js';
import type { RequestValidator } from '../../validator/request-validator.interface.js';
import { getRequestAttributes } from './get-request-attributes.js';
import { HonoMiddlewareAdapter } from './hono-middleware.adapter.js';
import { HonoRequestAdapter } from './hono-request.adapter.js';

export type HonoServeHandle = {
  close(): Promise<void>;
};

export type HonoServeFn = (app: Hono, port: number) => HonoServeHandle;

export type HonoServerOptions = {
  readonly port: number;
  readonly router: Router;
  readonly serve: HonoServeFn;
  readonly requestValidator?: RequestValidator;
  readonly logger?: Logger;
  readonly cors?: CorsOptions;
  readonly conventions?: HttpConventions;
};

export class HonoServer implements WebServer {
  private readonly app = new Hono();
  private readonly requestAdapter: HonoRequestAdapter;
  private readonly middlewareAdapter: HonoMiddlewareAdapter;
  private readonly errorResolver: ErrorResolver;
  private bootstrapped = false;
  private handle: HonoServeHandle | undefined;

  constructor(private readonly options: HonoServerOptions) {
    this.errorResolver = options.conventions?.errorResolver ?? new DefaultErrorResolver();
    const responseSerializer =
      options.conventions?.responseSerializer ?? new DefaultResponseSerializer();
    const requestDeserializer =
      options.conventions?.requestDeserializer ?? new DefaultRequestDeserializer();
    this.requestAdapter = new HonoRequestAdapter(
      options.router.getExecutionContextProvider(),
      responseSerializer,
      requestDeserializer,
    );
    this.middlewareAdapter = new HonoMiddlewareAdapter(this.requestAdapter);
  }

  bootstrap(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    this.app.onError((err, c) => {
      this.options.logger?.error('HTTP error', err instanceof Error ? err : undefined);
      const { httpCode, body } = this.errorResolver.resolve(err);
      return c.json(body, httpCode as never);
    });

    if (this.options.cors) {
      const { origins, exposeHeaders } = this.options.cors;
      this.app.use(
        '*',
        cors({
          origin: (origin) => (origins.includes(origin) ? origin : null),
          allowMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
          allowHeaders: ['Content-Type', 'Authorization', 'If-Match', 'ETag'],
          exposeHeaders: [...new Set(['ETag', ...(exposeHeaders ?? [])])],
          credentials: true,
          maxAge: 86400,
        }),
      );
    }

    const validator = this.options.requestValidator;
    if (validator) {
      this.app.use('*', async (c, next) => {
        const attributes = getRequestAttributes(c);
        attributes.set(HttpAttributes.REQUEST_VALIDATOR, validator);
        await next();
      });
    }

    for (const route of this.options.router.getRoutes()) {
      this.registerRoute(route);
    }
  }

  async listen(): Promise<void> {
    if (!this.bootstrapped) this.bootstrap();
    this.handle = this.options.serve(this.app, this.options.port);
    this.options.logger?.info('HTTP server listening', { meta: { port: this.options.port } });
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = undefined;
    this.options.logger?.info('HTTP server closed');
  }

  private registerRoute(route: NormalizedRoute): void {
    const stack: Array<(c: Context, next: Next) => Promise<void>> = [];
    for (const mw of route.middlewareChain) {
      stack.push(this.middlewareAdapter.wrap(mw));
    }
    const handler = this.requestAdapter.controller(route.handler);
    const method = route.httpMethod.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const register = this.app[method] as (path: string, ...handlers: unknown[]) => unknown;
    register.call(this.app, route.fullPath, ...stack, handler);
  }
}
