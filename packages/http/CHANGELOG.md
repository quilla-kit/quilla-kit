# @quilla-be-kit/http

## 0.12.0

### Minor Changes

- ea29f28: `@ValidateRequest(schema, sources, headers?)` gains a third, optional argument for injecting header-sourced fields into validated input — same mechanism as the existing `scopeId`/`userId` session injection, but sourced from a request header instead. This eliminates the per-controller glue previously needed for optimistic concurrency control (OCC): splicing an `If-Match`-derived value into the command after `getValidatedInput()` because the field couldn't live in the Zod schema.

  `updatedAt` is a reserved key, auto-sourced from the `If-Match` header whenever the schema declares it — no configuration needed, mirroring how `scopeId`/`userId` are auto-sourced from the session. Injection only happens when the header is actually sent; a merely-declared but unsent header never overwrites a body/params/query-supplied value with `null`. The new `headers: Readonly<Record<string, string>>` argument (schema key → header name) is both the escape hatch for any other header-sourced field and the override for a route that needs a different header (or field name) for OCC.

  ```ts
  const updateWidgetSchema = z.object({
    name: z.string(),
    updatedAt: z.string().transform(parseWeakEtag), // sourced from If-Match automatically
  });

  @Put('/:id')
  @ValidateRequest(updateWidgetSchema, ['body', 'params'])
  async update(req: HttpRequest): Promise<HttpResponse> {
    const command = req.getValidatedInput<UpdateWidgetCommand>();
    // command.updatedAt is already the parsed value
  }
  ```

  Backward compatible: the new argument is optional, and existing `@ValidateRequest(schema, sources)` call sites without an `updatedAt` field in their schema are unaffected.

## 0.11.0

### Minor Changes

- 6e9778f: CORS configuration is now adapter-agnostic. A new `CorsOptions` type (`{ origins: string[], exposeHeaders?: string[] }`) is exported from the package root, alongside `WebServer` and `HttpConventions`, and `HonoServer`'s `cors` option is typed as `CorsOptions` instead of the Hono-specific `HonoCorsOptions`, which is removed. Any future adapter (Express, Fastify, ...) accepts the same `CorsOptions` shape and translates it to its own framework's CORS mechanism, rather than each adapter inventing its own config type.

  **Breaking:** `HonoCorsOptions` is no longer exported from `@quilla-be-kit/http/adapter/hono`. Import `CorsOptions` from `@quilla-be-kit/http` instead — the shape is unchanged for existing consumers passing an `origins` array.

  `exposeHeaders?: string[]` is new on `CorsOptions`, forwarded to Hono's `cors({ exposeHeaders })` as `Access-Control-Expose-Headers`. Previously there was no way to expose custom response headers to cross-origin browser clients — in particular `ETag`, which the adapter already sends but which `fetch`'s `response.headers.get('etag')` cannot read cross-origin without this header. `ETag` is now exposed by default (matching the existing unconditional `If-Match`/`ETag` entries in `allowHeaders`), enabling apps that implement optimistic concurrency control (OCC) over HTTP to work cross-origin with zero config; `exposeHeaders` lets consumers add further custom headers on top.

## 0.10.1

### Patch Changes

- Updated dependencies [603c3af]
  - @quilla-be-kit/execution-context@0.3.0
  - @quilla-be-kit/observability@0.3.0

## 0.10.0

### Minor Changes

- af8e523: Map the seven new error categories to HTTP statuses

  `DefaultErrorResolver` now resolves `PaymentRequiredError` → 402,
  `GoneError` → 410, `PreconditionFailedError` → 412, `RateLimitError` → 429,
  `NotImplementedError` → 501, `UnavailableError` → 503, and `TimeoutError` →
  504, alongside the existing seven. Subclasses inherit their category's
  status, so an application error can get correct HTTP handling without
  importing anything from this package.

  This makes the `HttpStatusAware` brand added in 0.9.0 the escape hatch it was
  meant to be rather than the primary extension point — the README now says so,
  and steers you to a category first. The brand is unchanged and still outranks
  the category table.

  The category chain is also reordered by ascending status for readability. All
  categories are direct `QuillaError` subclasses, so no resolution changes.

### Patch Changes

- Updated dependencies [af8e523]
  - @quilla-be-kit/errors@0.3.0

## 0.9.0

### Minor Changes

- bb61488: Add `HttpStatusAware` so an error can declare its own HTTP status

  `DefaultErrorResolver` previously mapped errors to statuses with a closed
  `instanceof` chain over the eight `@quilla-be-kit/errors` categories, so a
  custom error outside that hierarchy silently resolved to 500 unless you
  replaced the whole resolver.

  Errors can now opt in by implementing `HttpStatusAware` — a
  `Symbol.for('quilla-be-kit.http.status')`-keyed brand that outranks the
  category table:

  ```ts
  export class GoneError extends QuillaError implements HttpStatusAware {
    readonly code: string = "GONE";
    readonly [HTTP_STATUS] = 410;
  }
  ```

  The brand is a symbol rather than a plain `httpCode` field so it can only be
  set deliberately: an error carrying an unrelated `httpCode` (an
  `ExternalError` subclass storing the upstream's status, say) keeps its
  category status instead of leaking that number to your clients. A branded
  value outside 100–599 or a non-integer is ignored rather than emitted.

  The category table is unchanged and still applies to unbranded errors,
  including subclasses, so `@ValidateRequest` → 400, `@AuthorizeScope` → 403,
  and the `security` middleware → 401 all behave exactly as before. Purely
  additive; `@quilla-be-kit/errors` gains no HTTP vocabulary.

  Exports: `HTTP_STATUS`, `HttpStatusAware`, `getDeclaredHttpStatus`.

### Patch Changes

- Updated dependencies [bb61488]
  - @quilla-be-kit/errors@0.2.2

## 0.8.0

### Minor Changes

- 99eb792: Replace the single global auth middleware stack with named auth stacks selectable per route, controller, or module.

  **BREAKING (pre-1.0):** `RouterOptions.authMiddlewares` is replaced by `authStacks` + `defaultAuthStack`, and `AuthMiddlewareStack.tokenVerification` is renamed `credentialVerification`. Both are compiler-caught; migration is mechanical:

  ```ts
  // before
  authMiddlewares: {
    tokenVerification: bearerTokenMiddleware({ tokenService }),
    sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }),
  },

  // after
  authStacks: {
    bearer: {
      credentialVerification: bearerTokenMiddleware({ tokenService }),
      sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }),
    },
  },
  defaultAuthStack: 'bearer',
  ```

  The phase is renamed because a stack may verify a JWT, an opaque token, an API key, or a client certificate — "token" named only one of them. The attribute it populates keeps the `VERIFIED_TOKEN` name, which is the contract with `@quilla-be-kit/security`'s `Token`.

  **Selecting a stack.** `authStack` is a new option on `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`, on `@Controller`, and on `HttpModuleMeta`, resolving `route ?? @Controller ?? module ?? defaultAuthStack` — the same precedence ladder as `version`, and an option on the existing decorators for the same reason: it is a Router-construction fact with no handler-wrapping behavior, so it rides in the same route registration and cannot be dropped by decorator ordering.

  `Router` is now generic over its stack names, so `defaultAuthStack` is constrained to the declared keys. Route-, controller-, and module-level `authStack` remain strings — decorators are evaluated independently of Router construction — and are validated at startup instead.

  **Every misconfiguration throws at construction, never at request time:** an empty `authStacks` record; `authStacks` without `executionContext`; a missing or undeclared `defaultAuthStack`; an undeclared stack named by a route, `@Controller`, or module; an `authStack` on a `*Public` route; and the same controller registered twice (whose copies would otherwise resolve to different stacks at different paths). The resolved chain lookup is itself the guard, so an unresolvable stack cannot degrade to "no auth".

  Router also stamps the resolved stack name on the request as `HttpAttributes.AUTH_STACK`, so guards can assert which stack authenticated a caller — `scopes` share one flat namespace across stacks and cannot carry that.

  Services with no authentication omit `authStacks` entirely and are unaffected.

  **Fix:** route metadata was read through the prototype-linked `Symbol.metadata` bag, so defining a subclass pushed its routes into the _parent's_ array. An app registering only the base class silently served the subclass's paths, and registering any subclassed controller threw `Duplicate route`. Route storage now uses own-property semantics, and metadata-bag walking dedupes by identity — a subclass with no decorators of its own inherits the parent's bag through the static class chain and previously yielded it twice.

  **Fix:** `@AuthorizeScope` and `@ValidateRequest` patched the last-registered route, so writing them _below_ the method decorator silently dropped their `scopes` / `scopeMode` / `validation` metadata — which every usage in this repo and its READMEs did. Patches now accumulate per class and merge at read time, making decorator order irrelevant. Enforcement was never affected (it lives in the returned wrappers, which are order-independent), so no runtime behavior changes; the metadata now describes what actually happens.

## 0.7.0

### Minor Changes

- d9439e9: Add a consumer-overridable inbound query dialect to `HttpConventions` — the
  request-side mirror of `responseSerializer`.

  `HttpConventions` gains an optional `requestDeserializer` (`RequestDeserializer`
  interface) that rewrites the raw query dict before validation. The exported
  `DefaultRequestDeserializer` renames a consumer's pagination keys onto the
  canonical `page` / `pageSize` that handlers and `@ValidateRequest` already read:

  ```ts
  new HonoServer({
    port,
    router,
    serve,
    conventions: {
      requestDeserializer: new DefaultRequestDeserializer({
        paginationKeys: { page: "p", pageSize: "per_page" },
      }),
    },
  });
  ```

  A pagination dialect is API-wide, so it's configured once at the server boundary
  — `GET /roles?p=2&per_page=50` reaches every handler as `page` / `pageSize` with
  no per-DTO changes. This aligns with `@quilla-fe-kit`'s `RepeatParamsSerializer`,
  which renames the same slots once in its constructor on the emitting end.

  Filter keys and all other query params pass through untouched; params and body
  are never touched. `sort` is intentionally not remappable — the `sort` key
  already agrees across request and response ends.

  Non-breaking: omitting `requestDeserializer` (or its `paginationKeys`) is an
  identity pass, so existing behavior is unchanged.

## 0.6.0

### Minor Changes

- 8ca907b: Make the HTTP error and success/envelope wire shapes consumer-overridable.

  `HonoServerOptions` gains an optional `conventions` facade holding two injectable strategies:

  - `errorResolver` (`ErrorResolver` interface) — controls the error status + body shape.
  - `responseSerializer` (`ResponseSerializer` interface) — controls the JSON success/envelope
    body (including `metadata.pagination` remapping).

  Omitting `conventions` preserves the current wire shape byte-for-byte via `DefaultErrorResolver`
  and `DefaultResponseSerializer`.

  The `error` barrel is now re-exported from the package root, so `ErrorResolver`,
  `DefaultErrorResolver`, and `ResolvedHttpError` are importable from `@quilla-be-kit/http`
  alongside `ResponseSerializer`, `DefaultResponseSerializer`, and `HttpConventions`.

  BREAKING (source): the free function `resolveHttpError` is removed in favor of
  `DefaultErrorResolver`. Replace `resolveHttpError(err)` with
  `new DefaultErrorResolver().resolve(err)`. The `ResolvedHttpError` type is unchanged and still
  exported.

## 0.5.0

### Minor Changes

- 4155cc3: Add API versioning to route composition.

  A version segment can now be declared at three levels and is inserted
  **resource-first** into the composed path, so each module stays a clean future
  service boundary:

  ```
  [module prefix] + [effective version] + [registration prefix] + [@Controller prefix] + [@Route path]
  ```

  The effective version resolves `route option ?? @Controller version ?? HttpModuleMeta.version ?? ''`:

  - `HttpModuleMeta.version?` — module-wide default.
  - `@Controller(prefix, { version })` — controller-level default.
  - `@Get('/x', { version })` (and every other method + `*Public` decorator via the
    new optional `RouteOptions` argument) — per-route override.

  Version lives on the method/controller decorators rather than a standalone
  decorator because it is a pure path-composition fact (like `path` and the
  `*Public` flag), with no runtime behavior — keeping it orthogonal to
  `@AuthorizeScope` / `@ValidateRequest`.

  Purely additive: when no version is set anywhere, composed paths are
  byte-identical to before. Version segments go through the existing
  leading-slash / no-trailing-slash normalization, and specificity sorting plus
  duplicate-route detection run on the composed path unchanged.

## 0.4.0

### Minor Changes

- 42a9ec0: Add `cors` option to `HonoServer` for built-in CORS support. Pass `cors: { origins: string[] }` and `HonoServer` registers Hono's built-in `cors()` middleware before routes so both preflight `OPTIONS` requests and actual cross-origin requests are handled automatically. Requests from unlisted origins receive no CORS headers; requests without an `Origin` header are unaffected. No additional dependency — `hono/cors` ships with Hono.

## 0.3.1

### Patch Changes

- 77153bc: Document `HttpRequest.getFile(name)` and `getFormFields()` for multipart/form-data handling. Both methods existed in the interface and Hono adapter but had no README coverage — consumers doing file uploads had no documented path.
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
  - @quilla-be-kit/execution-context@0.2.2
  - @quilla-be-kit/observability@0.2.2
  - @quilla-be-kit/runtime@0.2.2

## 0.3.0

### Minor Changes

- aec0823: feat(http): binary and stream responses

  `HttpResponse` becomes a discriminated union: `HttpJsonResponse |
HttpBinaryResponse | HttpStreamResponse`. JSON handlers keep the existing
  shape (`{ httpCode, payload, error?, metadata?, headers? }`) and continue
  to be wrapped in the standard envelope. Binary handlers return
  `{ httpCode, data: Uint8Array, headers? }`; stream handlers return
  `{ httpCode, stream: ReadableStream<Uint8Array>, headers? }`. The adapter
  discriminates by field presence (`'stream' in r` / `'data' in r`) and
  writes the bytes/stream directly — no JSON envelope, no `kind` tag to set.

  `content-type` lives in `headers` like every other header — the response
  shape does not invent a separate field for it.

  Tradeoff: binary responses lose the envelope convention. There's no
  `payload` / `metadata` wrapper around the bytes, and middleware can't
  introspect stream contents post-hoc. Errors thrown before the response
  starts still go through `resolveHttpError` and emit a normal JSON error;
  errors thrown mid-stream abort the connection.

  Existing handlers returning `{ httpCode, payload }` still satisfy
  `HttpJsonResponse` and therefore `HttpResponse` — no breaking change.
  `ResolvedHttpError.body` is narrowed from `Omit<HttpResponse, 'httpCode'>`
  to `Omit<HttpJsonResponse, 'httpCode'>`; error envelopes are always JSON.

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages
- Updated dependencies [30c8333]
  - @quilla-be-kit/errors@0.2.1
  - @quilla-be-kit/execution-context@0.2.1
  - @quilla-be-kit/observability@0.2.1
  - @quilla-be-kit/runtime@0.2.1

## 0.2.0

### Minor Changes

- 8c8e6af: **Breaking (pre-1.0):** consolidate `scopeId` and `userId` on
  `ExecutionContext` into a single optional `session: AuthSession`.

  The previous shape (`scopeId?`, `userId?` as top-level optionals on
  `ExecutionContext`) encoded two correlated fields as if they were
  orthogonal. In practice they share a lifecycle — both defined once auth
  middleware runs, both undefined for anonymous / system / job contexts,
  never half-populated in well-formed code. The type didn't enforce that.

  New shape:

  ```ts
  // @quilla-be-kit/execution-context
  export type AuthSession = {
    readonly scopeId: string;
    readonly userId: string;
  };

  export type ExecutionContext = {
    readonly actorType: ActorType;
    readonly correlationId: string;
    readonly session?: AuthSession; // present iff authenticated
  };
  ```

  `AuthSession` is extensible by intersection — same pattern as before for
  consumer-specific session data (roles, session id, etc.), but now anchored
  on a canonical base. `actorType` stays at the top level: `'system'` and
  `'job'` are meaningful with no session, and `actorType` classifies the
  broader context whether or not there's a session.

  **Affected toolkit surfaces (all updated):**

  - `@quilla-be-kit/execution-context` — `ExecutionContext.session?`,
    `AuthSession` exported type, `createFromEventMetadata` reconstructs the
    session from flat `EventMetadata.scopeId` / `userId` (metadata stays
    flat on the wire), `ExecutionContextEnricher` flattens `session` into
    top-level `scopeId` / `userId` log fields so log output shape is
    unchanged.
  - `@quilla-be-kit/persistence` — `BaseWriteDao` reads audit from
    `ctx.session?.userId`. System contexts with no session persist `null`
    audit.
  - `@quilla-be-kit/http` — `@ValidateRequest` reads auth from
    `ctx.session?.{scopeId,userId}`. Injection requires both a live
    session AND a `describeSchema` impl on the `RequestValidator`.
  - `@quilla-be-kit/security` — `authenticatedSessionMiddleware` now enriches
    the context with `session: { scopeId, userId }` instead of flat
    top-level fields.

  **`EventMetadata` is unchanged on the wire.** Flat `scopeId?` / `userId?`
  fields stay — they're a serialization format, and flattening is the right
  shape for JSON-persisted outbox rows. The conversion to/from session
  happens at the `createFromEventMetadata` boundary.

  **Log output is unchanged.** `ExecutionContextEnricher` flattens
  `session` to top-level `scopeId` / `userId` on every log entry, so
  dashboards and log queries keep their existing field names.

  **Consumer migration** — mechanical find-and-replace:

  - `ctx.scopeId` / `ctx.userId` → `ctx.session?.scopeId` /
    `ctx.session?.userId`
  - When constructing contexts in middleware / tests, nest scopeId & userId
    under `session: { scopeId, userId }` instead of placing them at the top.
  - Consumer extensions move from `ExecutionContext & { session?: MySession }`
    where MySession was free-form to
    `AuthSession & { ...extras }` with `ExecutionContext & { session?: AppAuthSession }`.

- ba7e94d: `@ValidateRequest` now injects `scopeId` and `userId` from the active
  `ExecutionContext` **only when the schema declares those keys**. The
  previous unconditional injection wrote the fields into every validated
  payload regardless of schema shape — which worked by accident for
  tolerant schemas (Zod silently stripped the extras) and broke strict
  schemas outright (unknown keys rejected). Worse, it conflated "what
  the schema represents" with "what the server happens to add on top,"
  making the decorator's contract ambiguous.

  New behavior:

  - `RequestValidator` gains an optional `describeSchema(schema)` method
    returning `{ keys }` or `null`. When implemented, `@ValidateRequest`
    reads the top-level key list and injects only declared auth-derived
    fields.
  - When `describeSchema` is absent or returns `null`, auth-injection is
    **skipped** — fail-safe: no surprise fields written into schemas that
    didn't ask for them.

  **Consumer impact:**

  Consumers with command DTOs that declare `scopeId` / `userId` and rely
  on auto-injection now need to add `describeSchema` to their
  `RequestValidator` wrapper (a 3–5 line addition for Zod; see the
  updated README). Without it, command DTOs land with `scopeId: undefined`
  at the handler — a loud failure rather than a silent miss, which is
  the intent.

  Consumers whose schemas don't declare `scopeId` / `userId` see no
  behavior change (injection was always a silent no-op for them, and
  now is explicitly so).

  The updated Zod adapter in the README handles `ZodObject` (direct key
  enumeration) and unwraps `ZodPipe` (produced by `.transform(...)`)
  until it reaches a `ZodObject` — so schemas produced by
  `createQueryParametersSchema` (a transform over an object) are
  introspected correctly and auth-derived extras are injected when
  declared via the new `extraFields` option in
  `@quilla-be-kit/persistence/query-schema`.

  **New: out-of-the-box Zod adapter.** `@quilla-be-kit/http/validator/zod`
  exports `createZodRequestValidator({ extractIssues? })` — a drop-in
  `RequestValidator` implementation for Zod 4 with the `ZodPipe` unwrap
  logic baked in. Avoids every consumer re-writing the same ~15 lines,
  and guarantees the unwrap chain matches what
  `createQueryParametersSchema` emits. `zod` is an optional peer dep of
  `@quilla-be-kit/http` — required only when importing from the
  `/validator/zod` sub-path.

- 0614b24: Initial HTTP surface. Ships framework-agnostic types, decorators, router, and a Hono adapter.

  - **Decorators** — `@Controller`, `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` + `*Public` variants, `@AuthorizeScope` (scope-based auth against `AuthenticatedToken`), `@ValidateRequest` (library-agnostic schema validation via injected `RequestValidator`).
  - **Router** — walks decorated controllers, composes prefixes (module + registration + controller + route), sorts by specificity, throws on duplicates. Bridges to `@quilla-be-kit/runtime`'s `ComponentRegistry<HttpModuleMeta>` for modular-monolith composition. Owns the full middleware chain composition: each `NormalizedRoute` carries a `middlewareChain` with the complete ordered pipeline `[system? → globals → (public ? [] : auth) → module → registration]`. Adapters iterate and wrap; they don't re-compose ordering, so future adapters (Express/Fastify) can't drift.
  - **System-owned execution-context bootstrap (optional).** `RouterOptions.executionContext: { provider, correlationIdHeader? }` installs an internal middleware that runs before any consumer middleware on every route. When omitted, the bootstrap is skipped (for pure-public services that never read context). Router throws at construction if `authMiddlewares` is set without `executionContext` — the known-static dependency is caught at startup. `HttpRequest.getExecutionContext()` throws a clear error if called without a wired provider.
  - **Typed auth middleware stack.** `RouterOptions.authMiddlewares: AuthMiddlewareStack` has shape `{ tokenVerification, sessionLoad? }`. Router runs phases in fixed order regardless of key declaration — phase misordering is a type error, not a runtime bug. Populated by `@quilla-be-kit/security`'s middleware factories.
  - **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes` constants.
  - **Validator contract** — `RequestValidator` returns `{ success, data }` | `{ success, error: unknown[] }`; library throws `ValidationError` on failure with `context.issues` preserved.
  - **Hono adapter** sub-path (`@quilla-be-kit/http/adapter/hono`) — `HonoServer implements WebServer`; reads the execution-context provider from the Router it wraps. Takes a `serve` callback so consumers pick their Node runtime (`@hono/node-server`, Bun, Deno, test stubs). `hono` pinned to `4.x.x` as optional peer dep. `HttpRequest` is cached on the Hono `Context` so middleware chains reuse a single wrapper per request.
  - **`MiddlewareAdapter.wrap(mw)`** — single-method contract. Adapters implement one hook; Router decides where each wrapped middleware plugs in.
  - **Internal error resolver** — `resolveHttpError` maps QuillaError subclasses to HTTP codes (400/401/403/404/409/502/500). Used by the Hono adapter's `onError` hook; not exposed to consumers.

  Stage-3 decorators require a `Symbol.metadata` well-known symbol; since Node 22 doesn't expose it natively, the package installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. `sideEffects` field narrows this to the single polyfill file so bundlers don't over-prune.

- ee7f1dc: Add `TokenClaims` (security) and rename `scope` → `scopes` on token-shaped types.

  **`TokenClaims` — canonical short-key wire-format type for JWT payloads.**
  `SignTokenPayload` and `Token` keep their readable developer-facing
  fields (`userId`, `scopeId`, `securityStamp`, `scopes`). `TokenClaims`
  gives `TokenService` implementers a typed target for the compact
  on-the-wire shape:

  ```ts
  type TokenClaims = {
    readonly u: string; // userId
    readonly si: string; // scopeId
    readonly st: string; // securityStamp
    readonly s?: readonly string[]; // scopes
  };
  ```

  Short keys exist for **payload size**, not security — JWTs travel in
  every authenticated request header, so claim names are a real
  bandwidth cost. Renaming developer-facing fields would not have helped
  (JWTs are signed, not encrypted, and the type definitions are public
  in OSS), so the split keeps ergonomics readable while making the wire
  contract explicit. Implementers map between the two at the sign/parse
  boundary — see the package README for a `jose` example.

  **Breaking (pre-1.0): `scope` → `scopes` on token-shaped types.** The
  field is a list, so the plural form matches the shape. Affects:

  - `@quilla-be-kit/http` — `AuthenticatedToken.scope?` → `scopes?`,
    `RouteDefinition.scope?` → `scopes?` (the `@AuthorizeScope` decorator
    name is unchanged — it describes the action; only the underlying
    field is plural).
  - `@quilla-be-kit/security` — `SignTokenPayload.scope?` → `scopes?`,
    `Token.scopes?` (inherited from `AuthenticatedToken`).

  `TokenClaims.s?` (the wire short key) is unchanged.

  **Consumer migration** — mechanical:

  - `token.scope` → `token.scopes`
  - `payload.scope` → `payload.scopes` when constructing a
    `SignTokenPayload`
  - Route metadata readers: `route.scope` → `route.scopes`

### Patch Changes

- Updated dependencies [8c8e6af]
- Updated dependencies [6ce0a43]
- Updated dependencies [f1dfa83]
- Updated dependencies [2bd37fe]
- Updated dependencies [45b7c58]
- Updated dependencies [7c86c48]
- Updated dependencies [7c86c48]
  - @quilla-be-kit/execution-context@0.2.0
  - @quilla-be-kit/errors@0.2.0
  - @quilla-be-kit/observability@0.2.0
  - @quilla-be-kit/runtime@0.2.0
