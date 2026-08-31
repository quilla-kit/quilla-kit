---
"@quilla-be-kit/http": minor
---

CORS configuration is now adapter-agnostic. A new `CorsOptions` type (`{ origins: string[], exposeHeaders?: string[] }`) is exported from the package root, alongside `WebServer` and `HttpConventions`, and `HonoServer`'s `cors` option is typed as `CorsOptions` instead of the Hono-specific `HonoCorsOptions`, which is removed. Any future adapter (Express, Fastify, ...) accepts the same `CorsOptions` shape and translates it to its own framework's CORS mechanism, rather than each adapter inventing its own config type.

**Breaking:** `HonoCorsOptions` is no longer exported from `@quilla-be-kit/http/adapter/hono`. Import `CorsOptions` from `@quilla-be-kit/http` instead — the shape is unchanged for existing consumers passing an `origins` array.

`exposeHeaders?: string[]` is new on `CorsOptions`, forwarded to Hono's `cors({ exposeHeaders })` as `Access-Control-Expose-Headers`. Previously there was no way to expose custom response headers to cross-origin browser clients — in particular `ETag`, which the adapter already sends but which `fetch`'s `response.headers.get('etag')` cannot read cross-origin without this header. `ETag` is now exposed by default (matching the existing unconditional `If-Match`/`ETag` entries in `allowHeaders`), enabling apps that implement optimistic concurrency control (OCC) over HTTP to work cross-origin with zero config; `exposeHeaders` lets consumers add further custom headers on top.
