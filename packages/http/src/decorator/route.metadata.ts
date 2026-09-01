import type { HeaderSourceMap } from '../validator/header-source.type.js';
import type { RequestSource } from '../validator/request-source.type.js';

// Node 22 has no native Symbol.metadata; stage-3 decorator emit writes metadata
// via `Symbol.metadata`, so we install a shared well-known identity at module
// load before any decorated class is defined.
if ((Symbol as { metadata?: symbol }).metadata === undefined) {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol.for('Symbol.metadata'),
    writable: false,
    configurable: false,
  });
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteDefinition = {
  readonly handlerMethodName: string;
  readonly httpMethod: HttpMethod;
  readonly path: string;
  readonly public: boolean;
  readonly version?: string;
  readonly authStack?: string;
  readonly scopes?: readonly string[];
  readonly scopeMode?: 'any' | 'all';
  readonly validation?: {
    readonly schema: unknown;
    readonly sources: readonly RequestSource[];
    readonly headers?: HeaderSourceMap;
  };
};

/**
 * Fields a patch decorator (`@AuthorizeScope`, `@ValidateRequest`) may set.
 * Narrowed deliberately: path, method, `public`, and `authStack` are decided by
 * the method decorator and must not be rewritable from a patch.
 */
export type RoutePatch = Pick<RouteDefinition, 'scopes' | 'scopeMode' | 'validation'>;

const CONTROLLER_PREFIX_KEY = Symbol.for('quilla-be-kit.http.controller-prefix');
const CONTROLLER_VERSION_KEY = Symbol.for('quilla-be-kit.http.controller-version');
const CONTROLLER_AUTH_STACK_KEY = Symbol.for('quilla-be-kit.http.controller-auth-stack');
const ROUTES_KEY = Symbol.for('quilla-be-kit.http.routes');
const ROUTE_PATCHES_KEY = Symbol.for('quilla-be-kit.http.route-patches');

type MetadataBag = Record<string | symbol, unknown>;

export function setControllerPrefix(metadata: MetadataBag, prefix: string): void {
  metadata[CONTROLLER_PREFIX_KEY] = prefix;
}

// Class-level settings OVERRIDE down the hierarchy: the nearest declaration
// wins. Read WITHOUT `Object.hasOwn`, unlike the route bag below — a subclass's
// metadata is prototype-linked to its parent's, so an undecorated subclass
// resolves the parent's value on the first walk step, which is exactly the
// child-wins-else-inherit precedence we want. Routes need the opposite
// (own-property) semantics because they ACCUMULATE rather than override.
function readInherited(controllerInstance: object, key: symbol): string | undefined {
  for (const metadata of walkMetadata(controllerInstance)) {
    if (typeof metadata[key] === 'string') return metadata[key] as string;
  }
  return undefined;
}

// Returns `''` (not `undefined`) when unset: prefixes from every level are
// concatenated, so an absent level just contributes nothing — unlike version
// (see getControllerVersion), where one level wins by precedence.
export function getControllerPrefix(controllerInstance: object): string {
  return readInherited(controllerInstance, CONTROLLER_PREFIX_KEY) ?? '';
}

export function setControllerVersion(metadata: MetadataBag, version: string | undefined): void {
  if (version === undefined) return;
  metadata[CONTROLLER_VERSION_KEY] = version;
}

// Returns `undefined` (not `''`) when unset so the router's nullish-coalescing
// precedence chain (route ?? controller ?? module) falls through correctly.
export function getControllerVersion(controllerInstance: object): string | undefined {
  return readInherited(controllerInstance, CONTROLLER_VERSION_KEY);
}

export function setControllerAuthStack(metadata: MetadataBag, authStack: string | undefined): void {
  if (authStack === undefined) return;
  metadata[CONTROLLER_AUTH_STACK_KEY] = authStack;
}

// Same precedence semantics as getControllerVersion.
export function getControllerAuthStack(controllerInstance: object): string | undefined {
  return readInherited(controllerInstance, CONTROLLER_AUTH_STACK_KEY);
}

// `Object.hasOwn`, not `??`: a subclass's metadata bag is prototype-linked to
// its parent's, so a bare read would resolve the parent's array and push the
// subclass's routes into it — leaking child routes onto the parent and making
// every inherited route collect twice.
export function addRoute(metadata: MetadataBag, route: RouteDefinition): void {
  const existing = Object.hasOwn(metadata, ROUTES_KEY)
    ? (metadata[ROUTES_KEY] as RouteDefinition[])
    : [];
  existing.push(route);
  metadata[ROUTES_KEY] = existing;
}

// Patches are accumulated per class and merged at read time so decorator order
// relative to the method decorator does not matter.
export function addRoutePatch(metadata: MetadataBag, methodName: string, patch: RoutePatch): void {
  const bucket = Object.hasOwn(metadata, ROUTE_PATCHES_KEY)
    ? (metadata[ROUTE_PATCHES_KEY] as Map<string, RoutePatch>)
    : new Map<string, RoutePatch>();
  bucket.set(methodName, { ...bucket.get(methodName), ...patch });
  metadata[ROUTE_PATCHES_KEY] = bucket;
}

export function getControllerRoutes(controllerInstance: object): readonly RouteDefinition[] {
  const collected: RouteDefinition[] = [];
  const patches = new Map<string, RoutePatch>();

  for (const metadata of walkMetadata(controllerInstance)) {
    if (Object.hasOwn(metadata, ROUTES_KEY)) {
      collected.unshift(...(metadata[ROUTES_KEY] as RouteDefinition[]));
    }
    if (Object.hasOwn(metadata, ROUTE_PATCHES_KEY)) {
      for (const [name, patch] of metadata[ROUTE_PATCHES_KEY] as Map<string, RoutePatch>) {
        // walkMetadata yields child-first, so anything already collected came
        // from the subclass and must win field-by-field over this parent's.
        const fromSubclass = patches.get(name);
        patches.set(name, { ...patch, ...fromSubclass });
      }
    }
  }

  if (patches.size === 0) return collected;
  return collected.map((def) => {
    const patch = patches.get(def.handlerMethodName);
    return patch ? { ...def, ...patch } : def;
  });
}

// Yields each class's OWN metadata bag, nearest class first.
//
// `Symbol.metadata` is inherited down the static constructor chain, so a class
// with no decorators of its own exposes its parent's bag. Reading the own
// property descriptor skips those classes entirely, which makes yielding the
// same bag twice impossible by construction rather than by bookkeeping.
function* walkMetadata(instance: object): Generator<MetadataBag> {
  // biome-ignore lint/suspicious/noExplicitAny: prototype reflection is inherently untyped
  let ctor: any = instance.constructor;
  while (ctor && ctor !== Object) {
    const own = Object.getOwnPropertyDescriptor(ctor, Symbol.metadata);
    if (own?.value) yield own.value as MetadataBag;
    const proto = ctor.prototype;
    ctor = proto ? Object.getPrototypeOf(proto)?.constructor : null;
  }
}
