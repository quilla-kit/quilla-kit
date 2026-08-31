# @quilla-be-kit/security

## 0.2.12

### Patch Changes

- Updated dependencies [6e9778f]
  - @quilla-be-kit/http@0.11.0

## 0.2.11

### Patch Changes

- Updated dependencies [603c3af]
  - @quilla-be-kit/execution-context@0.3.0
  - @quilla-be-kit/observability@0.3.0
  - @quilla-be-kit/http@0.10.1

## 0.2.10

### Patch Changes

- Updated dependencies [af8e523]
- Updated dependencies [af8e523]
  - @quilla-be-kit/errors@0.3.0
  - @quilla-be-kit/http@0.10.0

## 0.2.9

### Patch Changes

- Updated dependencies [bb61488]
- Updated dependencies [bb61488]
  - @quilla-be-kit/errors@0.2.2
  - @quilla-be-kit/http@0.9.0

## 0.2.8

### Patch Changes

- 99eb792: Document multi-audience authentication, following the named auth stacks in `@quilla-be-kit/http`.

  "Custom token schemes" becomes "Custom credential schemes" and now shows running a JWT stack and an API-key stack **concurrently** with per-route selection, rather than replacing the single stack. The quick start and middleware-chain sections are rewired to `authStacks` / `credentialVerification`.

  Two hazards are called out that the code cannot enforce:

  - **Each stack needs its own `sessionLoad`.** `authenticatedSessionMiddleware` keys `SessionStore` on `token.userId` alone and hardcodes `actorType: 'user'`. Reusing it for a second stack whose credential resolves to an existing user makes a human logout silently revoke machine access, and can never produce a non-user `actorType`. A custom `sessionLoad` must also populate `ExecutionContext.session` — `@ValidateRequest` injects `scopeId`/`userId` only when it is present, so omitting it fails open.
  - **Stacks must not share a credential verifier or signing key.** `TokenService.verify` takes no audience and `TokenClaims` carries no `aud`, so per-route stack selection is the only boundary between audiences.

  Docs only — no API change.

- Updated dependencies [99eb792]
  - @quilla-be-kit/http@0.8.0

## 0.2.7

### Patch Changes

- Updated dependencies [d9439e9]
  - @quilla-be-kit/http@0.7.0

## 0.2.6

### Patch Changes

- Updated dependencies [8ca907b]
  - @quilla-be-kit/http@0.6.0

## 0.2.5

### Patch Changes

- Updated dependencies [4155cc3]
  - @quilla-be-kit/http@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [42a9ec0]
  - @quilla-be-kit/http@0.4.0

## 0.2.3

### Patch Changes

- 77153bc: Document `Token.isExpired(now?: Date)` optional `now` parameter. The interface signature had it; the README intro listed `isExpired()` without it, leaving the testability injection point undiscovered.
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
  - @quilla-be-kit/execution-context@0.2.2
  - @quilla-be-kit/http@0.3.1
  - @quilla-be-kit/observability@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [aec0823]
  - @quilla-be-kit/http@0.3.0

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages
- Updated dependencies [30c8333]
  - @quilla-be-kit/errors@0.2.1
  - @quilla-be-kit/execution-context@0.2.1
  - @quilla-be-kit/http@0.2.1
  - @quilla-be-kit/observability@0.2.1

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

- 8e3a136: Initial security surface — interface-only primitives + auth middlewares that plug into `@quilla-be-kit/http`'s Router.

  - **`Token`** — extends `AuthenticatedToken` from http with `userId`, `scopeId`, `securityStamp`, `issuedAt`, `expiresAt`, `isExpired()`.
  - **`TokenService`** — `sign(payload, { expiresIn })` / `verify(raw)` interface. Consumer wires `jose`/`djwt`/`jsonwebtoken`/PASETO/opaque-reference in ~10 lines.
  - **`SignTokenPayload`** — payload shape for `TokenService.sign`: `{ userId, scopeId, securityStamp, scope? }`.
  - **`SessionStore`** / **`SessionData`** — keyed session record storage. Consumer picks backend (Redis, Valkey, DynamoDB, Postgres). `securityStamp` in the session is compared against the token's stamp for revocation (password change, logout, admin force-revoke).
  - **`PasswordHasher`** — `hash`/`compare` interface. Consumer wires `argon2`/`bcrypt`/`scrypt`.
  - **`bearerTokenMiddleware({ tokenService })`** — verifies `Authorization: Bearer ...`, populates `HttpAttributes.VERIFIED_TOKEN`, throws `UnauthorizedError` on any failure (preserving the verifier's native error in `cause`).
  - **`authenticatedSessionMiddleware({ sessionStore, executionContextProvider })`** — loads session, compares `securityStamp`, enriches `ExecutionContext` with `userId`/`scopeId`/`actorType: 'user'` via nested `runWithContext` for the remainder of the chain.

  Consumers compose the typed `AuthMiddlewareStack` (from `@quilla-be-kit/http`) directly: `{ tokenVerification: bearerTokenMiddleware({ tokenService }), sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }) }`. No builder helper — the phase shape is the API.

  Zero external runtime dependencies — no bundled JWT library, no cache driver, no hashing library. JWT alg choice, key rotation, cache backend, and password-hashing cost parameters are security decisions that belong in the consumer's composition root.

  Serves as the toolkit's rule-of-three validation harness: the first consumer that composes every other quilla-be-kit package together.

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
- Updated dependencies [ba7e94d]
- Updated dependencies [6ce0a43]
- Updated dependencies [f1dfa83]
- Updated dependencies [0614b24]
- Updated dependencies [2bd37fe]
- Updated dependencies [7c86c48]
- Updated dependencies [7c86c48]
- Updated dependencies [ee7f1dc]
  - @quilla-be-kit/execution-context@0.2.0
  - @quilla-be-kit/http@0.2.0
  - @quilla-be-kit/errors@0.2.0
  - @quilla-be-kit/observability@0.2.0
