# @quilla-be-kit/http

Framework-agnostic HTTP layer for a quilla-be-kit service:

- **Controller decorators** — `@Controller`, `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` + `*Public` variants, `@AuthorizeScope`, `@ValidateRequest`.
- **Router** — walks decorated controller instances, composes prefixes, sorts routes by specificity, bridges to `ComponentRegistry<HttpModuleMeta>` from `@quilla-be-kit/runtime`, and (when `executionContext` is configured) installs a **system-owned execution-context bootstrap** so every handler can rely on `provider.getContext()`.
- **Named auth stacks** — declare one stack per audience (`bearer` for humans, `apiKey` for machine-to-machine) and select one per route, controller, or module. `AuthMiddlewareStack` enforces phase ordering (`credentialVerification` → `sessionLoad?`) *within* a stack so consumers can't misorder security middlewares. Compose each from `@quilla-be-kit/security`'s middleware factories.
- **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes`.
- **Validator contract** — `RequestValidator` interface; wire Zod / Joi / Valibot / ArkType with a ~5-line adapter.
- **Hono adapter** — `@quilla-be-kit/http/adapter/hono` sub-path ships a `HonoServer` that implements `WebServer`. `hono` is an optional peer dep.

Runtime deps: `@quilla-be-kit/errors`, `@quilla-be-kit/execution-context`, `@quilla-be-kit/observability`, `@quilla-be-kit/runtime`.

## Install

```sh
# Core:
pnpm add @quilla-be-kit/http @quilla-be-kit/errors @quilla-be-kit/execution-context \
         @quilla-be-kit/observability @quilla-be-kit/runtime

# Plus Hono adapter:
pnpm add hono
```

Node 22+.

## TypeScript configuration

Controllers rely on **stage-3 decorators** (not the legacy `experimentalDecorators`). Your `tsconfig.json` needs:

```json
{
  "compilerOptions": {
    "target": "ES2022",                     // or higher
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
    // experimentalDecorators — must be false or omitted
    // emitDecoratorMetadata   — must be false or omitted
  }
}
```

- **TypeScript 5.0+** (5.2+ recommended).
- **`experimentalDecorators` must be `false` (or absent).** If you have it on for legacy reasons, `@Controller`/`@Get`/etc. will compile under the old decorator protocol and route metadata won't register. TS 5.x defaults to stage-3 when this flag is absent.
- **`target` ≥ `"ES2022"`.** Stage-3 decorators compile on top of ES2022 class semantics.

Consumers do **not** need to polyfill `Symbol.metadata` themselves — the library installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. You also do not need `emitDecoratorMetadata`; that's a legacy-decorator flag and does nothing for stage-3.

## Quick start

```ts
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import {
  Controller,
  Get,
  Post,
  GetPublic,
  AuthorizeScope,
  ValidateRequest,
  Router,
  type HttpRequest,
  type HttpResponse,
  type RequestValidator,
} from '@quilla-be-kit/http';
import { HonoServer } from '@quilla-be-kit/http/adapter/hono';
import { Runtime, ShutdownManager, ComponentRegistry } from '@quilla-be-kit/runtime';
import {
  authenticatedSessionMiddleware,
  bearerTokenMiddleware,
} from '@quilla-be-kit/security';
import { serve } from '@hono/node-server';

@Controller('/users')
class UsersController {
  @GetPublic('/healthz')
  async health(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200, payload: { ok: true } };
  }

  @Get('/:id')
  @AuthorizeScope('user:read')
  async show(req: HttpRequest): Promise<HttpResponse> {
    const id = req.getParams()['id'];
    return { httpCode: 200, payload: { id } };
  }

  @Post('/')
  @AuthorizeScope('user:write')
  @ValidateRequest(CreateUserRequestDto, ['body'])
  async create(req: HttpRequest): Promise<HttpResponse> {
    const input = req.getValidatedInput<CreateUserCommand>();
    // ... application logic
    return { httpCode: 201, payload: { id: 'new-id' } };
  }
}

const provider = new AsyncExecutionContextProvider();

const components = new ComponentRegistry<{
  readonly controllers?: readonly object[];
}>();

components.register({
  name: 'users',
  meta: { controllers: [new UsersController()] },
});

const router = new Router({
  modules: components.getAll(),
  executionContext: { provider },
  globalMiddlewares: [/* your custom globals (cors, rate-limit, request-logger, ...) */],
  authStacks: {
    bearer: {
      credentialVerification: bearerTokenMiddleware({ tokenService }),
      sessionLoad: authenticatedSessionMiddleware({
        sessionStore,
        executionContextProvider: provider,
      }),
    },
  },
  defaultAuthStack: 'bearer',
});

const server = new HonoServer({
  port: 3000,
  router,
  requestValidator: zodRequestValidator, // see below
  serve: (app, port) => {
    const handle = serve({ fetch: app.fetch, port });
    return {
      close: () =>
        new Promise<void>((resolve, reject) =>
          handle.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  },
});

const shutdown = new ShutdownManager({ timeoutMs: 10_000 });
shutdown.addPhase({
  name: 'http',
  participants: [{ name: 'HonoServer', dispose: () => server.close() }],
});

const runtime = new Runtime({ shutdownManager: shutdown });
await runtime.run(async () => {
  await server.listen();
});
```

## Decorators

### `@Controller(prefix, options?)`

Class decorator. Every route on the class gets `prefix` prepended. The optional
second argument carries controller-level **version** (see
[Versioning](#versioning)) and **auth stack** (see [Auth stacks](#auth-stacks))
defaults.

```ts
@Controller('/users')
class UsersController { ... }

@Controller('/users', { version: '/api/v1' })   // controller-wide version default
class UsersController { ... }

@Controller('/mcp', { authStack: 'apiKey' })    // controller-wide auth stack
class McpController { ... }
```

### HTTP method decorators

```ts
@Get(path, options?)          @GetPublic(path, options?)
@Post(path, options?)         @PostPublic(path, options?)
@Put(path, options?)          @PutPublic(path, options?)
@Patch(path, options?)        @PatchPublic(path, options?)
@Delete(path, options?)       @DeletePublic(path, options?)
```

The `*Public` variants mark the route as public — **the auth stack is skipped entirely** for these routes. The non-public variants run their resolved auth stack before the handler.

The optional `options` argument (`RouteOptions`) carries per-route **version**
(see [Versioning](#versioning)) and **auth stack** (see
[Auth stacks](#auth-stacks)) overrides:

```ts
@Get('/:id', { version: '/api/v2' })
@Get('/tools', { authStack: 'apiKey' })
```

Declaring `authStack` on a `*Public` route throws at Router construction — the
stack could never run, so silently ignoring it would be a bypass-shaped
surprise.

### Versioning

A version segment can be declared at three levels and is inserted
**resource-first** into the composed path — after the module prefix, before the
controller — so each module stays a clean future service boundary:

```
[module prefix] + [effective version] + [registration prefix] + [@Controller prefix] + [@Route path]
```

The effective version for a route resolves by precedence:

```
route option  ??  @Controller version  ??  HttpModuleMeta.version  ??  ''
```

- `HttpModuleMeta.version?` — module-wide default (see the [registry bridge](#bridge-to-componentregistryhttpmodulemeta)).
- `@Controller(prefix, { version })` — controller-level default.
- `@Get('/x', { version })` — per-route override (available on every method + `*Public` decorator).

```ts
@Controller('/auth', { version: '/api/v1' })   // default for the whole controller
class AuthController {
  @Get('/:id')                                 // → /iam/api/v1/auth/:id  (module prefix /iam)
  async show() {}

  @Get('/:id', { version: '/api/v2' })         // → /iam/api/v2/auth/:id  (route override)
  async showV2() {}
}
```

Version segments go through the same leading-slash / no-trailing-slash
normalization as every other segment (`/iam` + `api/v1` → `/iam/api/v1`, no double
slash). They are static, so they only **add** specificity and never trigger a
false duplicate; two routes that differ only by version resolve to distinct
paths. Version is orthogonal to `*Public` / auth — it affects the path only.
When no version is set anywhere, composed paths are byte-identical to a service
that never adopted versioning.

### Auth stacks

Declare one `AuthMiddlewareStack` per authentication audience and select one per
route. Stack names are yours; Router owns only selection, ordering, and failure
behavior.

```ts
const router = new Router({
  modules: components.getAll(),
  executionContext: { provider },
  authStacks: {
    bearer: {
      credentialVerification: bearerTokenMiddleware({ tokenService }),
      sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider: provider }),
    },
    apiKey: {
      credentialVerification: apiKeyMiddleware({ apiKeyService }),
      sessionLoad: machineSessionLoad,
    },
  },
  defaultAuthStack: 'bearer',   // type-checked against the declared keys
});
```

A route resolves to exactly one stack, most specific level winning:

```
@Get(path, { authStack })  ??  @Controller(prefix, { authStack })  ??  HttpModuleMeta.authStack  ??  defaultAuthStack
```

`*Public` routes skip the auth phase entirely, so they never resolve a stack —
a controller- or module-level `authStack` with a `*Public` sibling is fine and
common:

```ts
@Controller('/mcp', { authStack: 'apiKey' })
class McpController {
  @Get('/tools')       async tools(req) { ... }   // apiKey
  @GetPublic('/healthz') async health(req) { ... } // no auth
}
```

Router stamps the resolved name on the request as
`HttpAttributes.AUTH_STACK`, so a guard can assert *which* stack authenticated
the caller — `scopes` share one flat namespace across stacks and cannot carry
that distinction.

**Everything that can fail, fails at construction**, never at request time:

| Condition | Why it throws |
| --- | --- |
| `authStacks` present but empty | Every non-public route would run unauthenticated while looking configured. Omit the option for a service with no auth. |
| `authStacks` set without `executionContext` | Auth middlewares need an active `ExecutionContext` scope. |
| `authStacks` set without `defaultAuthStack` | Routes that declare nothing would have no stack. Also a compile-time error. |
| `defaultAuthStack` names an undeclared stack | Typo. Also a compile-time error. |
| A route / `@Controller` / module names an undeclared stack | Typo, reported with the controller and handler name. |
| `authStack` on a `*Public` route | Contradictory — the stack could never run. |
| The same controller registered twice | Its copies would resolve to different stacks at different paths. |

`defaultAuthStack` is constrained to the keys of `authStacks`, so a typo is a
type error before it is a runtime one. Route-, controller-, and module-level
`authStack` are plain strings — decorators and module metadata are evaluated
independently of Router construction, which is exactly why the runtime guards
above exist.

> **One controller, one audience.** Mixing two audiences within a controller is
> legal but usually a smell: a reviewer scanning the class can no longer tell its
> auth surface at a glance. Prefer a separate controller.

> **Stacks must not share a credential verifier or signing key.** Per-route
> selection is the only thing keeping audiences apart — a credential minted for
> one stack is otherwise verifiable by any stack holding the same key. Scope
> strings must likewise be globally unique across stacks.

### `@AuthorizeScope(scope, mode?)`

Scope-based authorization. Reads an `AuthenticatedToken` from `request.getAttribute(HttpAttributes.VERIFIED_TOKEN)` and checks the token's `scopes` against the required scope(s).

```ts
@AuthorizeScope('user:read')              // default: 'any' — passes if token has user:read
@AuthorizeScope(['user:read', 'admin'])   // passes if token has any of these
@AuthorizeScope(['user:write', 'admin'], 'all')  // requires both
```

Throws `ForbiddenError` on missing token or mismatch. An auth middleware (from `@quilla-be-kit/security` or consumer code) must have populated the `VERIFIED_TOKEN` attribute.

### `@ValidateRequest(schema, sources, headers?)`

Merges data from the configured sources (`'body'`, `'params'`, `'query'`), injects `scopeId` and `userId` from `ExecutionContext.session` **only when the schema declares those keys and a session is active**, injects header-sourced fields (see below), validates against `schema` using the server's `RequestValidator`, and attaches the validated value to the request. Retrieve with `request.getValidatedInput<T>()`.

Auth-injection requires two things:
- A live `session` on the request's `ExecutionContext` (i.e. the route ran through auth middleware that established one — anonymous and system contexts get no injection).
- The `RequestValidator` implements the optional `describeSchema(schema)` method (see [`RequestValidator` adapter](#requestvalidator-adapter) below). Without it, auth-injection is skipped entirely — a fail-safe default that keeps surprise fields out of schemas that didn't ask for them.

```ts
@Post('/')
@ValidateRequest(CreateUserRequestDto, ['body'])
async create(req: HttpRequest): Promise<HttpResponse> {
  const input = req.getValidatedInput<CreateUserCommand>();
  // input is typed as CreateUserCommand — consumer asserts the runtime shape
}
```

On validation failure, throws `ValidationError` with `context.issues` containing the validator's raw error array (e.g. Zod issues, Joi details). The default error resolver (`DefaultErrorResolver`) surfaces this as a 400 response with `body.error.details.issues`. See [Error status mapping](#error-status-mapping) for how that 400 is derived, and [Response and error conventions](#response-and-error-conventions) to override the wire shape.

#### Header-sourced fields (optimistic concurrency / `If-Match`)

`updatedAt` is a reserved key, same tier as `scopeId`/`userId`: whenever `describeSchema` reports the schema declares an `updatedAt` field, its raw value is auto-sourced from the `If-Match` header — no third argument required. Injection only happens when the header is actually sent; it never overwrites a body/params/query-supplied value with `null` just because `If-Match` was absent. Keep the actual OCC parsing (stripping the weak-validator prefix/quotes, converting to the target type) in the schema's own `.transform()` — the toolkit's job is only "read `If-Match`, inject its raw string value if present":

```ts
const updateWidgetSchema = z.object({
  name: z.string(),
  updatedAt: z.string().transform(parseWeakEtag), // sourced from If-Match automatically
});

@Put('/:id')
@ValidateRequest(updateWidgetSchema, ['body', 'params'])
async update(req: HttpRequest): Promise<HttpResponse> {
  const command = req.getValidatedInput<UpdateWidgetCommand>();
  // command.updatedAt is already the parsed value — no manual splicing needed,
  // and this works for DELETE routes with no body too.
}
```

The optional third argument, `headers: Readonly<Record<string, string>>` (schema key → header name), is both the escape hatch for any other header-sourced field and the override for a route that needs a different header (or field name) for OCC — entries here win over the `updatedAt`/`If-Match` default:

```ts
@Delete('/:id')
@ValidateRequest(deleteWidgetSchema, ['params'], { expectedUpdatedAt: 'X-Expected-Version' })
async delete(req: HttpRequest): Promise<HttpResponse> {
  const command = req.getValidatedInput<DeleteWidgetCommand>();
  // command.expectedUpdatedAt sourced from X-Expected-Version instead of
  // the default updatedAt/If-Match pairing
}
```

## Multipart / form-data

`HttpRequest` exposes two methods for multipart bodies:

```ts
getFile(name: string): File | null
getFormFields(): Record<string, string | readonly string[]>
```

- **`getFile(name)`** — returns the `File` object for the named file field, or `null` if absent or if the request is not multipart.
- **`getFormFields()`** — returns all non-file form fields as a flat record. Multi-value fields (e.g. checkboxes) are returned as `readonly string[]`; single-value fields as `string`. Returns an empty object when the request is not multipart.

```ts
@Post('/avatar')
async uploadAvatar(req: HttpRequest): Promise<HttpResponse> {
  const file = req.getFile('avatar');
  if (!file) return { httpCode: 400, error: { message: 'avatar field required' } };
  const fields = req.getFormFields();
  // fields: { caption: 'My photo', tags: ['travel', 'outdoors'] }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await this.avatarStore.save(userId, bytes, file.type);
  return { httpCode: 204 };
}
```

These methods are only available on multipart requests. For JSON bodies use `getBody()` as normal; `getFile` / `getFormFields` return `null` / `{}` on non-multipart requests.

## Binary and stream responses

`HttpResponse` is a union of three shapes:

```ts
type HttpResponse = HttpJsonResponse | HttpBinaryResponse | HttpStreamResponse;
```

- `HttpJsonResponse` — the default. Carries `payload` / `error` / `metadata` and gets wrapped in the standard envelope.
- `HttpBinaryResponse` — carries a `data: Uint8Array`. Adapter writes the bytes directly.
- `HttpStreamResponse` — carries a `stream: ReadableStream<Uint8Array>`. Adapter pipes the stream straight to the response.

The three are mutually exclusive at the type level. A handler picks the variant in its return type, and the adapter discriminates by field presence — there is no `kind` tag to set.

```ts
@Get('/:id/avatar')
async avatar(req: HttpRequest): Promise<HttpBinaryResponse> {
  const bytes = await this.avatars.load(req.getParams()['id']);
  return {
    httpCode: 200,
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    data: bytes,
  };
}

@Get('/:id/export')
async export(req: HttpRequest): Promise<HttpStreamResponse> {
  const stream = this.reports.streamCsv(req.getParams()['id']);
  return {
    httpCode: 200,
    headers: {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="report.csv"',
    },
    stream,
  };
}
```

`content-type` lives in `headers` like every other header — the response shape does not invent a separate field for it.

**The real tradeoff is that binary responses lose the envelope convention — no `payload` / `metadata` wrapper around the bytes, and middleware can't introspect stream contents post-hoc.** That's intrinsic to streaming, not a flaw: logging, response shaping, and validators that read response bodies all become no-ops on the binary path. You're opting out of the standard JSON shape so the framework can hand bytes directly to the socket.

Error handling caveat: a handler that throws **before** producing the response still goes through the configured error resolver (`DefaultErrorResolver` by default) and emits a normal JSON error envelope. A handler that throws **mid-stream** — after the response status is already committed — aborts the connection; the client sees a truncated body, not a JSON error.

## `RequestValidator` adapter

### Zod — use the out-of-the-box helper

The toolkit ships a ready-made Zod 4 adapter under `@quilla-be-kit/http/validator/zod`. It implements both `validate` and the optional `describeSchema` — the latter unwraps `ZodPipe` (produced by `.transform(...)`) so schemas from `@quilla-be-kit/persistence/query-schema` interoperate without any extra wiring.

```ts
import { createZodRequestValidator } from '@quilla-be-kit/http/validator/zod';

const server = new HonoServer({
  requestValidator: createZodRequestValidator(),
  // ...
});
```

Accepts an `extractIssues(error)` hook if you want to reshape Zod's raw issue array before it lands in `ValidationError.context.issues`:

```ts
createZodRequestValidator({
  extractIssues: (err) => err.issues.map((i) => ({ path: i.path, message: i.message })),
});
```

`zod` is an **optional** peer dep of `@quilla-be-kit/http` — required only when importing from this sub-path.

### Other validators — ~5 lines

If you use Joi, Valibot, ArkType, or anything else, implement `RequestValidator` directly:

```ts
// Joi
import type { Schema } from 'joi';

const joiRequestValidator: RequestValidator = {
  validate: (schema, input) => {
    const result = (schema as Schema).validate(input, { abortEarly: false });
    return result.error
      ? { success: false, error: result.error.details }
      : { success: true, data: result.value };
  },
  // Optional: implement describeSchema to enable conditional auth-injection
  // in @ValidateRequest. Return { keys } for schemas whose top-level keys
  // are enumerable, null otherwise.
};
```

Pass to `new HonoServer({ requestValidator, ... })`. The library handles conversion from the `{ success, error }` tuple to a thrown `ValidationError` — consumers never construct quilla-be-kit errors directly.

## Router

```ts
const router = new Router({
  controllers: [new UsersController()],   // plain controller instances
  // OR via modules from ComponentRegistry<HttpModuleMeta>:
  modules: registry.getAll(),

  // Optional — when provided, Router installs a system execution-context
  // bootstrap before any consumer middleware. Every route (public and
  // non-public) gets a baseline anonymous context with a correlation id
  // read from `correlationIdHeader` (default `'x-correlation-id'`) or a
  // generated UUID if absent.
  // **Required iff `authStacks` is set** — Router throws at construction
  // otherwise. Skip it for pure-public services that never call
  // `request.getExecutionContext()`. The provider carries its own factory
  // (default `executionContextFactory`); pass a custom factory via
  // `new AsyncExecutionContextProvider({ factory })` if you've extended the
  // ExecutionContext shape.
  executionContext: {
    provider,
    correlationIdHeader: 'x-request-id', // optional, defaults to 'x-correlation-id'
  },

  globalMiddlewares: [...],               // custom — run on every route after system bootstrap

  // Named auth stacks — non-public routes only. See "Auth stacks" above for
  // the resolution ladder and the full list of construction-time throws.
  authStacks: {
    bearer: { credentialVerification, sessionLoad? },
    apiKey: { credentialVerification, sessionLoad? },
  },
  defaultAuthStack: 'bearer',             // required with `authStacks`; typed to its keys
});
```

- Controllers can be registered as plain instances (no extra metadata) or wrapped in `{ controller, prefix?, middlewares? }` for per-controller prefix + middlewares.
- Routes are sorted by **specificity** (static segments > parametric > wildcard) so `/users/healthz` matches before `/users/:id`.
- Path composition: `[module prefix] + [effective version] + [registration prefix] + [@Controller prefix] + [@Route path]`, normalized to a single leading slash and no trailing slash. The **effective version** is resource-first and resolves `route option ?? @Controller version ?? HttpModuleMeta.version ?? ''` — see [Versioning](#versioning).
- Duplicate routes (same method + path) throw at construction time — you catch double-registrations at startup, not under load.
- Routes **accumulate** down a class hierarchy; they never replace. A subclass that re-decorates an inherited handler with a different path leaves the parent's route live at both paths. A subclass that overrides a decorated handler *without* re-decorating inherits the parent's route metadata while shadowing the wrapper the parent's `@AuthorizeScope` / `@ValidateRequest` installed — so the metadata claims a guard that no longer runs. Re-declare the decorators on the override.

### Middleware chain order

On a **non-public** route:

```
system executionContext bootstrap  →  globalMiddlewares[]  →  <stack> credentialVerification  →  <stack> sessionLoad?  →  route middlewares  →  handler
```

On a **`*Public` route**, the auth stack is skipped entirely:

```
system executionContext bootstrap  →  globalMiddlewares[]  →  route middlewares  →  handler
```

The system bootstrap is Router-owned and not configurable from outside — this eliminates "I forgot to add `executionContextMiddleware`" as a failure mode for services that use auth or read `ExecutionContext`. When `executionContext` is omitted, the bootstrap step is skipped entirely; services that never read context pay no boilerplate. Router throws at construction if `authStacks` is set without `executionContext` — the known-static dependency is caught at startup, not at the first authenticated request. The typed `AuthMiddlewareStack` prevents phase misordering within a stack at the type level; the array in `globalMiddlewares` stays open-ended because custom middleware ordering is consumer-owned.

Router composes the complete chain per route, including which auth stack applies. Adapters iterate `NormalizedRoute.middlewareChain` and wrap each entry — they never re-compose it, so phases cannot drift between adapters.

## Bridge to `ComponentRegistry<HttpModuleMeta>`

`ComponentRegistry<HttpModuleMeta>` is the shared spine between `@quilla-be-kit/runtime` and `@quilla-be-kit/http`:

```ts
import { ComponentRegistry } from '@quilla-be-kit/runtime';
import { type HttpModuleMeta } from '@quilla-be-kit/http';

const registry = new ComponentRegistry<HttpModuleMeta>({
  contracts: [IAM_CONTRACT, DM_CONTRACT],
});

registry
  .register({
    name: 'iam',
    meta: {
      prefix: '/iam',
      version: '/api/v1',                       // module-wide default; routes/controllers can override
      authStack: 'bearer',                      // module-wide default; routes/controllers can override
      controllers: [usersController, authController],
      middlewares: [iamModuleMw],
    },
    dispose: () => iamModule.dispose(),
  })
  .register({
    name: 'dm',
    meta: {
      prefix: '/dm',
      version: '/api/v1',
      controllers: [documentsController],
    },
  });

// Router reads the registry directly:
const router = new Router({ modules: registry.getAll(), ... });

// Shutdown phase reads the same registry:
shutdown.addPhase(registry.toShutdownPhase('modules'));
```

One source of truth: adding a new module means one `.register(...)` call, and both the route table and the shutdown ordering pick it up automatically.

## `WebServer` interface

```ts
export interface WebServer {
  bootstrap(): void | Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}
```

- `bootstrap()` — wires routes, middlewares, error handler onto the underlying framework. Idempotent.
- `listen()` — starts accepting connections.
- `close()` — stops accepting connections and awaits in-flight requests.

`HonoServer implements WebServer`. Future adapters (Express, Fastify) would ship as additional sub-paths implementing the same interface — `const server: WebServer = new HonoServer(...)` stays the shape your composition root depends on. Cross-cutting config that isn't framework-specific — `HttpConventions`, `CorsOptions` — lives alongside `WebServer` in the package root rather than inside an adapter, so every adapter's constructor options accept the same shapes.

## Hono adapter

Sub-path: `@quilla-be-kit/http/adapter/hono`. Ships `HonoServer` only. `hono` is an optional peer dep pinned to `4.x.x`.

```ts
import { HonoServer, type HonoServeFn } from '@quilla-be-kit/http/adapter/hono';
import { serve } from '@hono/node-server';

const honoServe: HonoServeFn = (app, port) => {
  const handle = serve({ fetch: app.fetch, port });
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        handle.close((err) => (err ? reject(err) : resolve())),
      ),
  };
};

const server = new HonoServer({
  port: 3000,
  router,                 // HonoServer reads the execution-context provider from Router
  requestValidator,       // optional — required only if any route uses @ValidateRequest
  logger,                 // optional — used for startup/shutdown/error logs
  conventions,            // optional — override the error / success wire shapes (see below)
  serve: honoServe,
});
```

The `serve` callback is where you pick your Node runtime — `@hono/node-server`, Bun's native serve, Deno's native serve, a test stub, etc. Runtime-specific so the adapter stays portable.

Consumer never constructs `HonoRequestAdapter` or `HonoMiddlewareAdapter` directly — `HonoServer` wires them internally.

### CORS

Pass `cors: CorsOptions` (`{ origins: string[], exposeHeaders?: string[] }`, exported from `@quilla-be-kit/http`) to enable CORS. `CorsOptions` is adapter-agnostic — any `WebServer` implementation accepts the same shape and translates it to its underlying framework's CORS mechanism. `HonoServer` registers Hono's built-in `cors()` middleware before any route, so preflight and actual requests are both handled — no extra dependency required (`hono/cors` ships with Hono).

```ts
const server = new HonoServer({
  port: 3000,
  router,
  serve: honoServe,
  cors: {
    origins: ['https://app.example.com', 'http://localhost:5173'],
    exposeHeaders: ['X-Request-Id'], // optional — 'ETag' is always exposed
  },
});
```

Requests from an unlisted origin receive no CORS headers — the browser blocks them. Requests with no `Origin` header (server-to-server) are unaffected.

Defaults applied when `cors` is set:

| Header | Value |
|---|---|
| `Access-Control-Allow-Methods` | `GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, If-Match, ETag` |
| `Access-Control-Expose-Headers` | `ETag` (plus anything in `exposeHeaders`) |
| `Access-Control-Allow-Credentials` | `true` |
| `Access-Control-Max-Age` | `86400` (24 h) |

`ETag` is exposed by default so cross-origin browser clients implementing optimistic concurrency control (OCC) can read the response header — see [`@quilla-be-kit/persistence`](../persistence/README.md) for OCC support. Use `exposeHeaders` to expose additional custom response headers.

If you need non-default values, omit `cors` and wire `hono/cors` yourself inside the `serve` callback, or raise an issue.

### Response and error conventions

The outbound success/envelope shape, the error shape, and the inbound query keys are all
consumer-overridable through the optional `conventions` facade on `HonoServer`. It groups three
strategies, each defaulting to a class that reproduces the built-in behavior byte-for-byte — omit
`conventions` and nothing changes.

```ts
type HttpConventions = {
  readonly errorResolver?: ErrorResolver;             // controls the error status + body
  readonly responseSerializer?: ResponseSerializer;   // controls the JSON success/envelope body
  readonly requestDeserializer?: RequestDeserializer; // controls the inbound query keys
};

interface ErrorResolver {
  resolve(err: unknown): ResolvedHttpError;          // { httpCode, body }
}
interface ResponseSerializer {
  serialize(response: HttpJsonResponse): unknown;    // return the wire body, or undefined for no body
}
interface RequestDeserializer {
  deserializeQuery(query: Record<string, string | readonly string[]>): Record<string, string | readonly string[]>;
}
```

Defaults are exported so a custom strategy can delegate to them: `DefaultErrorResolver` (the
status mapping — see [Error status mapping](#error-status-mapping)), `DefaultResponseSerializer`
(strips `httpCode`/`headers`, keeps `payload` / `error` / `metadata`, and returns `undefined`
for an empty body so it becomes a bodyless response), and `DefaultRequestDeserializer` (an
identity pass unless configured with `paginationKeys`).

#### Error status mapping

`DefaultErrorResolver` resolves a status in three steps, first match wins.

**1. The category table.** These are the defaults for the error categories `@quilla-be-kit/http`
ships against — and throws itself, so changing them changes documented behavior:

| Error | Status | Thrown by the toolkit at |
|---|---|---|
| `ValidationError` | 400 | `@ValidateRequest` |
| `UnauthorizedError` | 401 | `@quilla-be-kit/security` bearer-token and session middleware |
| `PaymentRequiredError` | 402 | — |
| `ForbiddenError` | 403 | `@AuthorizeScope` |
| `NotFoundError` | 404 | — |
| `ConflictError` | 409 | — |
| `GoneError` | 410 | — |
| `PreconditionFailedError` | 412 | — |
| `RateLimitError` | 429 | — |
| `InternalError` (and `UnknownError`) | 500 | — |
| `NotImplementedError` | 501 | — |
| `ExternalError` | 502 | — |
| `UnavailableError` | 503 | — |
| `TimeoutError` | 504 | — |

The table lives here, in the HTTP layer, rather than on the error classes: `@quilla-be-kit/errors`
is transport-agnostic and is consumed by `messaging` and `persistence`, where a status code means
nothing.

**2. Subclass a category — this is what you want.** Inheritance carries the status down, so a
narrower `code` costs nothing and your domain code never imports `@quilla-be-kit/http`:

```ts
import { ConflictError, GoneError, NotFoundError } from '@quilla-be-kit/errors';

export class ResourceRetiredError extends GoneError {
  override readonly code: string = 'RESOURCE_RETIRED';                     // → 410
}
```

`@quilla-be-kit/persistence` already relies on this — `OptimisticLockError extends ConflictError`
→ 409, `CrossScopeAccessError extends NotFoundError` → 404.

**3. Brand the error — escape hatch, rarely needed.** Reach for this only when the category table
genuinely has no entry for what you need — a vendor-specific status, or overriding a status you
inherited. It requires importing from `@quilla-be-kit/http`, so prefer a category wherever one
fits; if you find yourself branding the same status across projects, open an issue and it should
become a category instead.

```ts
import { QuillaError } from '@quilla-be-kit/errors';
import { HTTP_STATUS, type HttpStatusAware } from '@quilla-be-kit/http';

export class TeapotError extends QuillaError implements HttpStatusAware {
  readonly code: string = 'TEAPOT';
  readonly [HTTP_STATUS] = 418;
}
```

The brand is a `Symbol.for('quilla-be-kit.http.status')` key rather than a plain `httpCode` field
so that it can only ever be set deliberately — an error that happens to carry an unrelated
`httpCode` (say, an `ExternalError` subclass storing the *upstream's* status) keeps its category
status instead of leaking that number to your own clients.

A branded value outside 100–599, or one that isn't an integer, is ignored and the error falls
through to the category table. Anything that isn't a `QuillaError` at all resolves to a generic
500 with a redacted body, brand or no brand.

**Custom error format** — e.g. RFC 7807 Problem Details, reusing the default status mapping:

```ts
import {
  DefaultErrorResolver,
  type ErrorResolver,
  type ResolvedHttpError,
} from '@quilla-be-kit/http';

class ProblemDetailsResolver implements ErrorResolver {
  private readonly base = new DefaultErrorResolver();

  resolve(err: unknown): ResolvedHttpError {
    const { httpCode, body } = this.base.resolve(err);   // reuse status mapping
    return {
      httpCode,
      body: {
        error: {
          name: 'about:blank',
          message: body.error?.message ?? 'Error',
          details: { status: httpCode, ...(body.error?.details ?? {}) },
        },
      },
    };
  }
}

const server = new HonoServer({
  port: 3000,
  router,
  serve: honoServe,
  conventions: { errorResolver: new ProblemDetailsResolver() },
});
```

**Custom success envelope** — e.g. rename `payload` → `data` and lift pagination to the top level:

```ts
import {
  type HttpJsonResponse,
  type ResponseSerializer,
} from '@quilla-be-kit/http';

class DataEnvelopeSerializer implements ResponseSerializer {
  serialize(r: HttpJsonResponse): unknown {
    if (r.error) return { error: r.error };
    if (r.payload === undefined) return undefined;       // preserve the bodyless-response branch
    const p = r.metadata?.pagination;
    return {
      data: r.payload,
      ...(p ? { pagination: { page: p.page, perPage: p.limit, total: p.total } } : {}),
    };
  }
}

const server = new HonoServer({
  port: 3000,
  router,
  serve: honoServe,
  conventions: { responseSerializer: new DataEnvelopeSerializer() },
});
```

The binary/stream response paths never touch the serializer — they still write bytes directly.
On the frontend, `@quilla-fe-kit/api-client-react-query` reconciles a custom envelope with a
`queryTransformer`, and `@quilla-fe-kit/api-client` a custom error shape with an `errorParser`.

**Custom request query dialect** — the request-side mirror of `responseSerializer`. A pagination
dialect is API-wide, so rather than repeat it at every list schema, rename the query keys once at
the boundary. `DefaultRequestDeserializer` rewrites a consumer's keys onto the canonical `page` /
`pageSize` every handler (and `@ValidateRequest`) already reads, so no DTO changes:

```ts
import { DefaultRequestDeserializer } from '@quilla-be-kit/http';

const server = new HonoServer({
  port: 3000,
  router,
  serve: honoServe,
  conventions: {
    requestDeserializer: new DefaultRequestDeserializer({
      paginationKeys: { page: 'p', pageSize: 'per_page' },
    }),
  },
});
```

Now `GET /roles?p=2&per_page=50` reaches handlers as `page` / `pageSize`. This lines up with the
frontend: `@quilla-fe-kit`'s `RepeatParamsSerializer` renames the same slots on the emitting end
(also configured once, in its constructor), so both ends speak one dialect for full round-trip
symmetry. `sort` is intentionally not remappable — the `sort` key already agrees across ends.

Only pagination keys are renamed; filter keys and all other query params pass through untouched.
For a bespoke rule, implement `RequestDeserializer` directly. Non-query sources (params, body)
are never touched.

## Other frameworks

If you need Express or Fastify: open an issue. Adapter sub-paths ship as library additions when they exist, not as consumer extension points.

## Testing controllers

Since controllers are plain classes with decorators, you test them the way you'd test any class — construct an instance, pass a fake `HttpRequest`, assert the `HttpResponse`. No framework, no server, no adapter.

```ts
const controller = new UsersController();
const response = await controller.show(fakeRequest({ params: { id: '42' } }));
expect(response.httpCode).toBe(200);
```

For integration tests, use `HonoServer` with a `serve` callback that captures `app.fetch` — see this package's adapter tests for the pattern.
