export function createEventsModule(): any {
  // A function constructor, as in Node: pre-class code inherits with
  // `EventEmitter.call(this)` + util.inherits, and subclasses that never call
  // it (mocha's Suite) still work because the listener table is made lazily.
  type Listener = Function & { listener?: Function };
  const table = (self: any): Record<string, Listener[]> => {
    if (!self._events || !Object.prototype.hasOwnProperty.call(self, '_events')) {
      Object.defineProperty(self, '_events', { value: Object.create(null), writable: true, configurable: true });
    }
    return self._events;
  };
  function EventEmitter(this: any) {
    if (!(this instanceof EventEmitter)) return;
    table(this);
  }
  const P: any = EventEmitter.prototype;
  P.on = P.addListener = function (event: string | symbol, fn: Function) {
    const t = table(this);
    if (t.newListener) this.emit('newListener', event, (fn as Listener).listener ?? fn);
    ((t as any)[event] ??= []).push(fn);
    return this;
  };
  P.prependListener = function (event: string | symbol, fn: Function) {
    const t = table(this);
    if (t.newListener) this.emit('newListener', event, (fn as Listener).listener ?? fn);
    ((t as any)[event] ??= []).unshift(fn);
    return this;
  };
  P.off = P.removeListener = function (event: string | symbol, fn: Function) {
    const t: any = table(this);
    const list: Listener[] | undefined = t[event];
    if (!list) return this;
    const i = list.findIndex(f => f === fn || f.listener === fn);
    if (i < 0) return this;
    list.splice(i, 1);
    if (!list.length) delete t[event];
    if (t.removeListener) this.emit('removeListener', event, fn);
    return this;
  };
  P.once = function (event: string | symbol, fn: Function) {
    const self = this;
    const wrapper: Listener = function (this: any, ...args: any[]) { self.off(event, wrapper); return fn.apply(this, args); };
    wrapper.listener = fn;
    return this.on(event, wrapper);
  };
  P.prependOnceListener = function (event: string | symbol, fn: Function) {
    const self = this;
    const wrapper: Listener = function (this: any, ...args: any[]) { self.off(event, wrapper); return fn.apply(this, args); };
    wrapper.listener = fn;
    return this.prependListener(event, wrapper);
  };
  P.emit = function (event: string | symbol, ...args: any[]) {
    const list: Listener[] | undefined = (table(this) as any)[event];
    if (!list || !list.length) {
      if (event === 'error') {
        const err = args[0];
        throw err instanceof Error ? err : new Error(`Unhandled error. (${String(err)})`);
      }
      return false;
    }
    for (const fn of [...list]) fn.apply(this, args);
    return true;
  };
  P.removeAllListeners = function (event?: string | symbol) {
    if (event === undefined) this._events = Object.create(null);
    else delete (table(this) as any)[event];
    return this;
  };
  P.listeners = function (event: string | symbol) {
    return ((table(this) as any)[event] || []).map((f: Listener) => f.listener ?? f);
  };
  P.rawListeners = function (event: string | symbol) { return [...((table(this) as any)[event] || [])]; };
  P.listenerCount = function (event: string | symbol) { return ((table(this) as any)[event] || []).length; };
  P.eventNames = function () { return Reflect.ownKeys(table(this)); };
  P.setMaxListeners = function (n: number) { this._maxListeners = n; return this; };
  P.getMaxListeners = function () { return this._maxListeners ?? 10; };
  // The events module default export IS EventEmitter (allows `class Foo extends require('events')`)
  const mod: any = EventEmitter;
  mod.prototype = P;
  mod.EventEmitter = EventEmitter;
  // (not enumerable: node's events has no `default`)
  Object.defineProperty(mod, 'default', { value: EventEmitter, writable: true, configurable: true, enumerable: false });
  // Static helpers used by some libraries
  mod.once = async (emitter: any, event: string) => {
    return new Promise<any[]>((resolve) => {
      emitter.once(event, (...args: any[]) => resolve(args));
    });
  };
  mod.on = (emitter: any, event: string) => {
    const events: any[] = [];
    emitter.on(event, (...args: any[]) => events.push(args));
    return { [Symbol.asyncIterator]: async function*() { while (true) { if (events.length) yield events.shift(); else await new Promise(r => setTimeout(r, 10)); } } };
  };
  mod.getEventListeners = (emitter: any, event: string) => emitter.listeners?.(event) || [];
  mod.getMaxListeners = (emitter: any) => emitter.getMaxListeners?.() || 10;
  mod.setMaxListeners = (n: number, ...emitters: any[]) => { emitters.forEach(e => e.setMaxListeners?.(n)); };
  mod.defaultMaxListeners = 10;
  mod.listenerCount = (emitter: any, event: string) => emitter.listenerCount?.(event) || 0;
  // An EventEmitter with an async resource (tinypool, vitest's worker pool, extends it: without it
  // vitest failed at start with "Class extends value undefined"). Its resource runs listeners
  // in place: async context isn't carried here, as AsyncLocalStorage carries it across awaits
  let nextAsyncId = 1;
  class EventEmitterAsyncResource extends (EventEmitter as any) {
    #resource: any;
    constructor(options?: string | { name?: string; triggerAsyncId?: number; requireManualDestroy?: boolean; captureRejections?: boolean }) {
      const name = typeof options === 'string' ? options : options?.name ?? new.target.name;
      super(typeof options === 'string' ? undefined : options);
      const id = nextAsyncId++, trigger = (typeof options === 'object' && options?.triggerAsyncId) || 0;
      const emitter = this;
      this.#resource = {
        type: name, eventEmitter: emitter,
        asyncId: () => id, triggerAsyncId: () => trigger,
        emitDestroy() { return this; },
        runInAsyncScope: (fn: Function, thisArg?: unknown, ...args: unknown[]) => fn.apply(thisArg, args),
        bind: (fn: Function) => fn,
      };
    }
    emit(event: string | symbol, ...args: unknown[]): boolean { return this.#resource.runInAsyncScope(super.emit, this, event, ...args); }
    emitDestroy(): void { this.#resource.emitDestroy(); }
    get asyncId(): number { return this.#resource.asyncId(); }
    get triggerAsyncId(): number { return this.#resource.triggerAsyncId(); }
    get asyncResource(): any { return this.#resource; }
  }
  mod.EventEmitterAsyncResource = EventEmitterAsyncResource;
  return mod;
}
