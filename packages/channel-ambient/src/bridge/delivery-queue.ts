// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The per-room delivery FIFO: the brain receives inputs in the order they reached the channel.
 *
 * Every input that can become a brain ingress holds a place from the moment it arrives: a message
 * at acceptance, a room utterance when its `transcript` frame arrives. A place becomes ready when
 * the input may be handed over (a typed message at once, a voice message once its text is known, a
 * room utterance once the judge decided `ingress`), and the head is delivered whenever it is
 * ready. An input decided against (`ignore`, `ack`, `stop`, a failed voice message) leaves its
 * place without delivery.
 *
 * "Earlier" is arrival order at the channel, never a timestamp: room rows carry the cerebellum
 * host's clock and messages the channel host's, so comparing them would order inputs by clock skew.
 *
 * There is no timeout. Every place is released by a fact: each `transcript` frame is followed by
 * exactly one `action` frame for its utterance, a voice message ends cleaned or failed, and a
 * cerebellum disconnect removes every room utterance still waiting (`dropRoom`).
 *
 * A delivery may return a promise: the queue then holds every later place until it settles. A
 * message uses this to persist its row before the brain call is issued, so the next input cannot
 * overtake it while the append is on disk.
 */

export type DeliveryKind = "message" | "room";

/** A delivery; a returned promise holds the queue until it settles. */
export type Deliver = () => void | Promise<unknown>;

type Place = { id: string; kind: DeliveryKind; deliver: Deliver | null };

export type DeliveryQueue = {
  /** Take a place at the tail. A second enqueue of a queued id is ignored. */
  enqueue(id: string, kind: DeliveryKind): void;
  /**
   * Mark a place ready with its delivery. An id with no place (its arrival was seen on an earlier
   * link, or never) is enqueued at the tail first: its arrival is now.
   */
  ready(id: string, kind: DeliveryKind, deliver: Deliver): void;
  /** Leave the queue without delivery. Unknown ids are ignored. */
  remove(id: string): void;
  /**
   * Remove every room utterance still waiting, ready or not; returns their ids. A ready one behind
   * an unfinished message belongs to the link that just died: delivering it later would hand the
   * brain speech from an epoch the room has left.
   */
  dropRoom(): string[];
  has(id: string): boolean;
  size(): number;
};

export function createDeliveryQueue(): DeliveryQueue {
  const places: Place[] = [];
  let pumping = false;
  /** A delivery returned a promise that has not settled yet. */
  let holding = false;

  const release = (): void => {
    holding = false;
    pump();
  };

  /**
   * Deliver from the head while it is ready. A delivery may enqueue or ready other inputs (for
   * example a message accepted inside the callback); the loop picks those up instead of
   * re-entering, so delivery order stays queue order.
   */
  function pump(): void {
    if (pumping || holding) return;
    pumping = true;
    try {
      while (!holding && places[0]?.deliver) {
        const head = places.shift()!;
        const pending = head.deliver!();
        if (pending) {
          holding = true;
          void pending.then(release, release);
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    enqueue(id, kind): void {
      if (places.some((p) => p.id === id)) return;
      places.push({ id, kind, deliver: null });
    },

    ready(id, kind, deliver): void {
      let place = places.find((p) => p.id === id);
      if (!place) {
        place = { id, kind, deliver: null };
        places.push(place);
      }
      place.deliver = deliver;
      pump();
    },

    remove(id): void {
      const index = places.findIndex((p) => p.id === id);
      if (index < 0) return;
      places.splice(index, 1);
      pump();
    },

    dropRoom(): string[] {
      const dropped: string[] = [];
      for (let i = places.length - 1; i >= 0; i -= 1) {
        const place = places[i]!;
        if (place.kind !== "room") continue;
        dropped.unshift(place.id);
        places.splice(i, 1);
      }
      pump();
      return dropped;
    },

    has: (id) => places.some((p) => p.id === id),
    size: () => places.length
  };
}
