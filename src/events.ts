// src/events.ts

type Listener = (...args: any[]) => void;

/**
 * A minimal, dependency-free event emitter for cross-platform compatibility.
 */
export class SimpleEventEmitter {
  private events: Map<string, Listener[]> = new Map();

  /**
   * Subscribes to an event.
   * @param {string} eventName The name of the event to listen for.
   * @param {Listener} listener The callback function.
   */
  on(eventName: string, listener: Listener): void {
    const listeners = this.events.get(eventName) || [];
    listeners.push(listener);
    this.events.set(eventName, listeners);
  }

  /**
   * Unsubscribes from an event.
   * @param {string} eventName The name of the event.
   * @param {Listener} listener The callback function to remove.
   */
  off(eventName: string, listener: Listener): void {
    const listeners = this.events.get(eventName);
    if (!listeners) return;

    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emits an event, calling all subscribed listeners.
   * @param {string} eventName The name of the event to emit.
   * @param {...any[]} args Arguments to pass to the listeners.
   */
  emit(eventName: string, ...args: any[]): void {
    const listeners = this.events.get(eventName);
    if (!listeners) return;

    // Iterate over a copy in case a listener modifies the array during emission
    [...listeners].forEach((listener) => {
      listener(...args);
    });
  }
}
