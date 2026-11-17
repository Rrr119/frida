/**
 * Type declarations for frida-java-hook-kit.
 * The bridge types are intentionally structural so the package does not
 * require @types/frida-gum at compile time for consumers.
 */

export interface JavaType {
  className: string;
  type: string;
  isCompatible (value: unknown): boolean;
}

export interface BridgeMethod {
  methodName: string;
  holder: { $n: string };
  type: number;
  handle: unknown;
  argumentTypes: JavaType[];
  returnType: JavaType;
  overloads: BridgeMethod[];
  implementation: ((...args: any[]) => any) | null;
  apply (receiver: unknown, args: unknown[]): unknown;
}

export interface BridgeClass {
  $n: string;
  [methodName: string]: BridgeMethod | unknown;
}

export interface InvocationContext {
  method: BridgeMethod;
  methodName: string;
  className: string;
  static: boolean;
  callOriginal (...args: any[]): any;
  [key: string]: unknown;
}

export interface HookSpec {
  className: string;
  methodName: string;
  /** JNI type names; omit for the unique overload, '*' for all overloads */
  argTypes?: string[] | '*';
  onEnter?: (args: unknown[], ctx: InvocationContext) => void;
  onLeave?: (retval: unknown, args: unknown[], ctx: InvocationContext) => unknown;
  handler?: (args: unknown[], ctx: InvocationContext) => unknown;
  passthrough?: boolean;
  extras?: Record<string, unknown>;
}

export interface InstalledHook {
  key: string;
  className: string;
  methodName: string;
  signature: string;
  method: BridgeMethod;
  originalImpl: ((...args: any[]) => any) | null;
}

export interface BatchReport {
  installed: InstalledHook[];
  errors: Error[];
  skipped: string[];
}

export interface CacheStats {
  classes: number;
  methods: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class HookCache {
  hits: number;
  misses: number;
  getClass (className: string): BridgeClass | undefined;
  putClass (className: string, wrapper: BridgeClass): BridgeClass;
  getMethod (key: string): BridgeMethod | undefined;
  putMethod (key: string, method: BridgeMethod): BridgeMethod;
  hasMethod (key: string): boolean;
  clear (): void;
  readonly stats: CacheStats;
}

export function makeMethodKey (className: string, methodName: string, argTypes?: string[]): string;

export class OverloadError extends Error {
  available: string[][];
}

export function resolveOverload (dispatcher: BridgeMethod, argTypes?: string[]): BridgeMethod;
export function resolveAllOverloads (
  dispatcher: BridgeMethod,
  predicate?: (method: BridgeMethod) => boolean
): BridgeMethod[];
export function signatureOf (method: BridgeMethod): string;

export function bindOriginal (method: BridgeMethod, receiver: unknown): (...args: any[]) => any;
export function makeInvocationHandler (
  method: BridgeMethod,
  handler: (args: unknown[], ctx: InvocationContext) => unknown,
  extras?: Record<string, unknown>
): (...args: any[]) => any;
export function passthroughHandler (method: BridgeMethod): (...args: any[]) => any;

export interface HookManagerOptions {
  java?: any;
  cache?: HookCache;
  throwOnError?: boolean;
}

export default class HookManager {
  constructor (options?: HookManagerOptions);
  cache: HookCache;
  installed: Map<string, InstalledHook>;
  useClass (className: string): BridgeClass;
  resolveMethod (className: string, methodName: string, argTypes?: string[]): { key: string; method: BridgeMethod };
  install (spec: HookSpec): InstalledHook[];
  installBatch (specs: HookSpec[]): BatchReport;
  revert (key: string): boolean;
  revertAll (): number;
  replaceHandler (key: string, spec: HookSpec): InstalledHook;
  isStatic (method: BridgeMethod): boolean;
}

export function hookBatch (specs: HookSpec[], options?: HookManagerOptions): BatchReport & { manager: HookManager };
