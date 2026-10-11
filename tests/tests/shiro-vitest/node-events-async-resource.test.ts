/**
 * events.EventEmitterAsyncResource exists (tinypool, vitest's worker pool,
 * extends it: vitest 3 failed at start with "Class extends value undefined").
 */
import { describe, it, expect } from 'vitest';
import { createEventsModule } from '@shiro/node-compat/modules/events';

describe('events.EventEmitterAsyncResource', () => {
  const events = createEventsModule();
  it('is an EventEmitter that can be extended, with its async resource', () => {
    class Pool extends events.EventEmitterAsyncResource {
      constructor() { super({ name: 'Pool' }); }
    }
    const p = new Pool();
    expect(p).toBeInstanceOf(events.EventEmitter);
    const got: unknown[] = [];
    p.on('x', (a: unknown, b: unknown) => got.push(a, b));
    expect(p.emit('x', 1, 2)).toBe(true);
    expect(got).toEqual([1, 2]);
    expect(typeof p.asyncId).toBe('number');
    expect(p.asyncResource.type).toBe('Pool');
    expect(p.asyncResource.eventEmitter).toBe(p);
    expect(p.asyncResource.runInAsyncScope((x: number) => x * 2, null, 21)).toBe(42);
    p.emitDestroy();
  });
  it('takes a name as a string, and defaults it to the class name', () => {
    expect(new events.EventEmitterAsyncResource('N').asyncResource.type).toBe('N');
    class Named extends events.EventEmitterAsyncResource {}
    expect(new Named().asyncResource.type).toBe('Named');
  });
});
