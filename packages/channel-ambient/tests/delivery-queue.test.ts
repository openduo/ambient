// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createDeliveryQueue } from "../src/bridge/delivery-queue";

/** The brain receives inputs in arrival order; a ready input never overtakes an earlier one. */
describe("delivery FIFO", () => {
  function harness() {
    const q = createDeliveryQueue();
    const out: string[] = [];
    const ready = (id: string, kind: "message" | "room" = "room") =>
      q.ready(id, kind, () => {
        out.push(id);
      });
    return { q, out, ready };
  }

  it("delivers a ready head at once", () => {
    const h = harness();
    h.ready("m1", "message");
    expect(h.out).toEqual(["m1"]);
    expect(h.q.size()).toBe(0);
  });

  it("holds a later ready input behind an earlier one that is not ready", () => {
    const h = harness();
    h.q.enqueue("u1", "room");
    h.q.enqueue("m1", "message");
    h.ready("m1", "message");
    expect(h.out).toEqual([]);
    h.ready("u1");
    expect(h.out).toEqual(["u1", "m1"]);
  });

  it("lets an input decided against leave without delivery and releases what waits behind", () => {
    const h = harness();
    h.q.enqueue("u1", "room");
    h.q.enqueue("m1", "message");
    h.ready("m1", "message");
    h.q.remove("u1");
    expect(h.out).toEqual(["m1"]);
  });

  it("queues a ready input it never saw at the tail", () => {
    const h = harness();
    h.q.enqueue("u1", "room");
    h.ready("u9");
    expect(h.out).toEqual([]);
    h.q.remove("u1");
    expect(h.out).toEqual(["u9"]);
  });

  it("drops every waiting room utterance, ready or not, when the perception link is lost", () => {
    const h = harness();
    h.q.enqueue("u1", "room");
    h.q.enqueue("m1", "message");
    h.q.enqueue("u2", "room");
    h.ready("u2");
    expect(h.q.dropRoom()).toEqual(["u1", "u2"]);
    expect(h.out).toEqual([]);
    expect(h.q.has("m1")).toBe(true);
    h.ready("m1", "message");
    expect(h.out).toEqual(["m1"]);
  });

  it("holds later inputs while a delivery's promise is pending", async () => {
    const q = createDeliveryQueue();
    const out: string[] = [];
    let finish!: () => void;
    q.enqueue("m1", "message");
    q.enqueue("u1", "room");
    q.ready("m1", "message", () => {
      out.push("m1 start");
      return new Promise<void>((resolve) => {
        finish = () => {
          out.push("m1 end");
          resolve();
        };
      });
    });
    q.ready("u1", "room", () => {
      out.push("u1");
    });
    expect(out).toEqual(["m1 start"]);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(out).toEqual(["m1 start", "m1 end", "u1"]);
  });

  it("releases the queue when a delivery's promise rejects", async () => {
    const q = createDeliveryQueue();
    const out: string[] = [];
    q.ready("m1", "message", () => Promise.reject(new Error("disk full")));
    q.ready("m2", "message", () => {
      out.push("m2");
    });
    expect(out).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(out).toEqual(["m2"]);
  });

  it("keeps queue order when a delivery readies another input", () => {
    const q = createDeliveryQueue();
    const out: string[] = [];
    q.enqueue("a", "message");
    q.enqueue("b", "message");
    q.ready("b", "message", () => {
      out.push("b");
    });
    q.ready("a", "message", () => {
      out.push("a");
      q.ready("c", "message", () => {
        out.push("c");
      });
    });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("ignores a second enqueue and an unknown removal", () => {
    const h = harness();
    h.q.enqueue("u1", "room");
    h.q.enqueue("u1", "room");
    h.q.remove("nope");
    expect(h.q.size()).toBe(1);
  });
});
