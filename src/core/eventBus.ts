import { EventEmitter } from 'node:events';
import type { AppEvents } from './events.ts';

/**
 * Типизированная обёртка над EventEmitter. Даёт автодополнение и проверку
 * типов на payload для каждого имени события из AppEvents.
 */
export class TypedEventBus {
  private readonly emitter = new EventEmitter();

  on<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

/** Общая шина событий приложения (singleton). */
export const eventBus = new TypedEventBus();
