---
"@quilla-be-kit/http": minor
---

`@ValidateRequest(schema, sources, headers?)` gains a third, optional argument for injecting header-sourced fields into validated input — same mechanism as the existing `scopeId`/`userId` session injection, but sourced from a request header instead. This eliminates the per-controller glue previously needed for optimistic concurrency control (OCC): splicing an `If-Match`-derived value into the command after `getValidatedInput()` because the field couldn't live in the Zod schema.

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
