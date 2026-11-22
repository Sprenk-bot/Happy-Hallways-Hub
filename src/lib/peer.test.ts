import { afterEach, describe, expect, test } from "bun:test";

/**
 * Fictional PeerJS/DataConnection doubles. Only the events and properties the
 * reconnect and heartbeat logic touches are modelled here.
 */
type Listener = (payload?: unknown) => void;

class FakePeer {
  open = false;
  disconnected = false;
  destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();
  reconnects = 0;

  on(event: string, listener: Listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, payload?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  reconnect() {
    this.reconnects += 1;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeConnection {
  open = true;
  private readonly listeners = new Map<string, Listener[]>();
  sent: unknown[] = [];

  on(event: string, listener: Listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, payload?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.open = false;
    this.emit("close");
  }
}

import {
  keepAlive,
  keepAliveTimings,
  reconnectBackoff,
} from "./peer";

/** Minimal typing for the browser timers the module schedules via `window`. */
type FakeWindow = {
  setTimeout: (fn: () => void, ms: number) => number;
  setInterval: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  clearInterval: (id: number) => void;
};

/**
 * Extracts the timers a created peer would schedule, by running the same
 * backoff rules the module implements against a fake peer.
 */
describe("peer connection helpers (fictional doubles, fake timers)", () => {
  let now: number;

  let timeouts: { id: number; ms: number; fn: () => void }[] = [];
  let intervals: { id: number; ms: number; fn: () => void }[] = [];
  let nextId = 1;

  const setUpTimers = () => {
    timeouts = [];
    intervals = [];
    nextId = 1;
    now = 1_000_000;
    const fakeWindow: FakeWindow = {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timeouts.push({ id, ms, fn });
        return id;
      },
      setInterval: (fn: () => void, ms: number) => {
        const id = nextId++;
        intervals.push({ id, ms, fn });
        return id;
      },
      clearTimeout: (id: number) => {
        timeouts = timeouts.filter((timer) => timer.id !== id);
      },
      clearInterval: (id: number) => {
        intervals = intervals.filter((timer) => timer.id !== id);
      },
    };
    (globalThis as unknown as { window: FakeWindow | null }).window = fakeWindow;
    const RealDate = globalThis.Date;
    class FakeDate extends RealDate {
      static now() {
        return now;
      }
    }
    (globalThis as unknown as { Date: DateConstructor }).Date =
      FakeDate as unknown as DateConstructor;
  };

  setUpTimers();

  afterEach(() => {
    setUpTimers();
  });

  test("reconnect backs off exponentially and resets after a successful open", () => {
    const peer = new FakePeer();

    // Mirror of createPeer's handler wiring (see src/lib/peer.ts).
    let delay = reconnectBackoff.startMs;
    let timer = 0;
    peer.on("open", () => (delay = reconnectBackoff.startMs));
    peer.on("disconnected", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!peer.destroyed && peer.disconnected) peer.reconnect();
      }, delay);
      delay = Math.min(delay * 2, reconnectBackoff.maxMs);
    });
    peer.on("close", () => {
      clearTimeout(timer);
      timer = 0;
    });

    peer.disconnected = true;
    peer.emit("disconnected");
    expect(timeouts.map((entry) => entry.ms)).toEqual([3000]);

    timeouts[0].fn();
    expect(peer.reconnects).toBe(1);

    peer.emit("disconnected");
    expect(timeouts.map((entry) => entry.ms)).toEqual([3000, 6000]);

    // A successful open resets the backoff.
    peer.emit("open");
    peer.emit("disconnected");
    expect(timeouts.at(-1)!.ms).toBe(reconnectBackoff.startMs);

    // Close cancels any pending reconnect: the peer is destroyed on close, so
    // even firing the pending timer's callback must not reconnect.
    const pendingFn = timeouts.at(-1)!.fn;
    peer.destroyed = true;
    peer.emit("close");
    const reconnectsBefore = peer.reconnects;
    pendingFn();
    peer.emit("disconnected");
    expect(peer.reconnects).toBe(reconnectsBefore);
  });

  test("keepAlive closes a silent connection and stops its heartbeat", () => {
    const connection = new FakeConnection();
    keepAlive(connection as never);

    const heartbeatId = intervals.at(-1)!.id;
    const heartbeatFn = () =>
      intervals.find((entry) => entry.id === heartbeatId)?.fn();
    expect(intervals.find((entry) => entry.id === heartbeatId)?.ms).toBe(
      keepAliveTimings.heartbeatMs,
    );

    // Hearing data pushes the silence deadline out.
    now += 10_000;
    connection.emit("data");

    // Still within the 15s silence window since the last heard data.
    now += 10_000;
    heartbeatFn();
    expect(connection.open).toBe(true);
    expect(connection.sent).toContainEqual({ type: "ping" });

    // Silence past the deadline closes the connection and clears the interval.
    now += keepAliveTimings.silentMs + 1_000;
    heartbeatFn();
    expect(connection.open).toBe(false);
    // The heartbeat stopped: firing it again sends nothing more.
    const sentBeforeIdleTick = connection.sent.length;
    heartbeatFn();
    expect(connection.sent.length).toBe(sentBeforeIdleTick);
    expect(connection.sent).not.toContainEqual({ type: "ping", after: "close" });
    expect(connection.sent.filter((entry) => entry && (entry as { type?: string }).type === "ping").length).toBe(1);
  });
});
