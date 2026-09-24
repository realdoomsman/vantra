import type { WsMsg, WsMsgOf, WsMsgType } from '@vantra/shared';
import type { EventBus } from './interfaces.js';
import type { Logger } from '../lib/log.js';

type Listener = (msg: WsMsg) => void;

// In-process typed emitter. Listener errors are logged and never propagate to the emitter,
// so a broken WS client or stats subscriber cannot break a step.
export function createBus(log: Logger): EventBus {
  const byType = new Map<WsMsgType, Set<Listener>>();
  const any = new Set<Listener>();

  const call = (listener: Listener, msg: WsMsg) => {
    try {
      listener(msg);
    } catch (e) {
      log.error({ err: e, type: msg.type }, 'bus listener failed');
    }
  };

  return {
    emit(msg) {
      byType.get(msg.type)?.forEach((l) => call(l, msg));
      any.forEach((l) => call(l, msg));
    },
    on<T extends WsMsgType>(type: T, listener: (msg: WsMsgOf<T>) => void) {
      const set = byType.get(type) ?? new Set<Listener>();
      byType.set(type, set);
      const wrapped = listener as Listener;
      set.add(wrapped);
      return () => { set.delete(wrapped); };
    },
    onAny(listener) {
      any.add(listener);
      return () => { any.delete(listener); };
    },
  };
}
