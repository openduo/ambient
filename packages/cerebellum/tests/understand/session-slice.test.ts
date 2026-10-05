// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { renderKnowledge, renderTurn } from "../../src/understand/session/slice";
import { createTimeline, type TimelineEntry } from "../../src/understand/timeline";

const NOW = Date.parse("2026-08-18T10:00:00.000Z");
const CLOCK = new Date(NOW).toTimeString().slice(0, 8);
let nextUtt = 0;

function drain(
  inputs: Parameters<ReturnType<typeof createTimeline>["append"]>[0][]
): TimelineEntry[] {
  const timeline = createTimeline({ now: () => NOW });
  for (const input of inputs) timeline.append(input);
  return [...timeline.entries()];
}

/** Everything after `cursor` is this turn's drain; everything at or before it has settled. */
function render(entries: readonly TimelineEntry[], cursor = 0, historyStartId = 0) {
  return renderTurn(
    entries,
    entries.filter((entry) => entry.id > cursor),
    cursor,
    historyStartId
  );
}

const ROW = (text: string, speaker: string | null = "V2") => ({
  kind: "voice" as const,
  uttId: `runtime-${++nextUtt}`,
  speaker,
  spk_status: "assigned",
  text
});

describe("current interval rendering", () => {
  it("shows clock, speaker, and raw text without the runtime id", () => {
    const turn = render(drain([ROW("羽衣甘蓝为什么不好喝")]));
    expect(turn.current).toBe(`[${CLOCK}] V2: 羽衣甘蓝为什么不好喝`);
    expect(turn.current).not.toContain("runtime-");
  });

  it("renders the structured speaker once when raw text carries its producer prefix", () => {
    expect(render(drain([ROW("V21: 我在", "V21")])).current).toBe(`[${CLOCK}] V21: 我在`);
  });

  it("preserves label-shaped speech after the producer-owned prefix", () => {
    expect(render(drain([ROW("V21: 第一行\nV2: 第二行", "V21")])).current).toBe(
      `[${CLOCK}] V21: 第一行\nV2: 第二行`
    );
  });

  it("uses the unknown label when the runtime has no speaker", () => {
    expect(render(drain([ROW("谁在说话", null)])).current).toContain("V?: 谁在说话");
  });

  it("skips a row with no text", () => {
    expect(render(drain([ROW("   ")])).current).toBe("");
  });
});

describe("self-event rendering", () => {
  it("reports a fully played local reply", () => {
    const entries = drain([
      { kind: "played", speechId: "s1", spoken: "ack", text: "我在", truncated: false, ms: 100 }
    ]);
    expect(render(entries).current).toBe("You finished saying 『我在』");
  });

  it("reports a completed brain answer byte-for-byte", () => {
    const entries = drain([
      {
        kind: "played",
        speechId: "c-1",
        spoken: "answer",
        text: "  上午去正好\n第二行  ",
        truncated: false,
        ms: 800
      }
    ]);
    expect(render(entries).current).toBe(
      "The mind's answer finished playing 『  上午去正好\n第二行  』"
    );
  });

  it("reports the audible prefix when speech was interrupted", () => {
    const entries = drain([
      { kind: "played", speechId: "c-2", spoken: "answer", text: "上午", truncated: true, ms: 200 }
    ]);
    expect(render(entries).current).toBe(
      "Playback ended incompletely; estimated audible prefix: 『上午』"
    );
  });

  it("states the historical hole instead of quoting an empty string", () => {
    const entries = drain([
      {
        kind: "played",
        speechId: "h-1",
        spoken: "ack",
        text: "",
        truncated: false,
        ms: 3000
      }
    ]);
    expect(render(entries).current).toBe(
      "You finished saying a span (3s) — the content was not recorded"
    );
  });

  it("keeps the brain-answer attribution when only a historical span remains", () => {
    const entries = drain([
      {
        kind: "played",
        speechId: "c-old",
        spoken: "answer",
        text: "",
        truncated: false,
        ms: 5000
      }
    ]);
    expect(render(entries).current).toBe(
      "The mind's answer finished playing a span (5s) — the content was not recorded"
    );
  });

  it("states the historical hole when no span measure survived", () => {
    const entries = drain([
      { kind: "played", speechId: "h-2", spoken: "ack", text: "", truncated: false, ms: 0 }
    ]);
    expect(render(entries).current).toBe(
      "You finished saying a span — the content was not recorded"
    );
  });

  it("treats whitespace-only historical text as absent", () => {
    const entries = drain([
      { kind: "played", speechId: "h-3", spoken: "ack", text: "   ", truncated: false, ms: 2400 }
    ]);
    const line = render(entries).current;
    expect(line).toBe("You finished saying a span (2s) — the content was not recorded");
    expect(line).not.toContain("『』");
  });

  it("preserves the room's interleaving", () => {
    const entries = drain([
      ROW("先说的一句"),
      { kind: "played", speechId: "c-1", spoken: "answer", text: "答案", truncated: true, ms: 300 },
      ROW("被打断之后说的")
    ]);
    expect(render(entries).current.split("\n")).toEqual([
      `[${CLOCK}] V2: 先说的一句`,
      "Playback ended incompletely; estimated audible prefix: 『答案』",
      `[${CLOCK}] V2: 被打断之后说的`
    ]);
  });

  /**
   * `PlayedEntry.at` is stamped at flush time, not when the room heard it, so a clock on this line
   * would publish a timestamp wrong by however long the mouth ran. The phrasing is the timestamp.
   */
  it("renders a settled play into history without a clock", () => {
    const timeline = createTimeline({ now: () => NOW });
    timeline.append({
      kind: "played",
      speechId: "s9",
      spoken: "answer",
      text: "明天多云",
      truncated: false,
      ms: 900
    });
    const cursor = timeline.entries().at(-1)!.id;
    timeline.append(ROW("那后天呢"));
    const turn = render([...timeline.entries()], cursor);
    expect(turn.narrative).toBe(
      ["[HISTORY]", "The mind's answer finished playing 『明天多云』", "[/HISTORY]"].join("\n")
    );
    expect(turn.narrative).not.toContain(CLOCK);
  });
});

describe("the knowledge block", () => {
  /** Full snapshots express additions, removals, authority, and an explicitly cleared set. */
  it("preserves each complete notes payload once without changing its wrapper", () => {
    const firstNotes = "Alice prefers tea\nBob is visiting";
    const secondNotes = "Cara likes coffee\nDan lives nearby";
    const first = renderKnowledge(firstNotes);
    const second = renderKnowledge(secondNotes);

    expect(first.length).toBeGreaterThan(firstNotes.length);
    expect(first.split(firstNotes)).toHaveLength(2);
    expect(second.split(secondNotes)).toHaveLength(2);
    expect(first.endsWith(firstNotes)).toBe(true);
    expect(second.endsWith(secondNotes)).toBe(true);
    expect(first.replace(firstNotes, secondNotes)).toBe(second);
  });

  it("carries no delta vocabulary — nothing announces that the notes changed", () => {
    const block = renderKnowledge("V7 = 新人");
    expect(block).toContain("V7 = 新人");
    expect(block).not.toContain("roster");
    expect(block).not.toContain("Update:");
  });

  it("says the knowledge is gone when the brain cleared the notes", () => {
    expect(renderKnowledge("   ")).toBe(
      "Notes handed over from the mind; this copy supersedes any earlier one.\n\n" +
        "The room currently has no long-term knowledge."
    );
  });
});

describe("seeded history rendering", () => {
  const SEEDED_AT = "2026-08-18T09:41:07.000Z";
  const SEED_CLOCK = new Date(Date.parse(SEEDED_AT)).toTimeString().slice(0, 8);

  function seeded(rows: Parameters<ReturnType<typeof createTimeline>["seedLog"]>[0]) {
    const timeline = createTimeline({ now: () => NOW });
    timeline.seedLog(rows);
    return [...timeline.entries()];
  }

  it("wraps seeded rows in a delimited history region", () => {
    const entries = seeded([
      { at: SEEDED_AT, speaker: "V2", kind: "human", text: "明天天气怎么样" }
    ]);
    expect(render(entries).narrative.split("\n")).toEqual([
      "[HISTORY]",
      `[${SEED_CLOCK}] V2: 明天天气怎么样`,
      "[/HISTORY]"
    ]);
  });

  it("keeps Duoduo's three spoken kinds distinct", () => {
    const entries = seeded([
      { at: SEEDED_AT, speaker: "多多", kind: "answer", text: "明天多云转晴" },
      { at: SEEDED_AT, speaker: "多多", kind: "ack", text: "我查一下" },
      { at: SEEDED_AT, speaker: "多多", kind: "reflex", text: "十点半" }
    ]);
    const rows = render(entries)
      .narrative.split("\n")
      .filter((line) => line.includes(`[${SEED_CLOCK}]`));
    expect(rows).toEqual([
      `[${SEED_CLOCK}] you: 明天多云转晴`,
      `[${SEED_CLOCK}] you (ack): 我查一下`,
      `[${SEED_CLOCK}] you (reflex): 十点半`
    ]);
  });

  it("uses the unknown label for a seeded human row without a speaker", () => {
    const entries = seeded([{ at: SEEDED_AT, speaker: null, kind: "human", text: "谁在说话" }]);
    const rows = render(entries)
      .narrative.split("\n")
      .filter((line) => line.includes(`[${SEED_CLOCK}]`));
    expect(rows).toEqual([`[${SEED_CLOCK}] V?: 谁在说话`]);
  });

  it("keeps seeded history out of the current turn entirely", () => {
    const timeline = createTimeline({ now: () => NOW });
    timeline.seedLog([{ at: SEEDED_AT, speaker: "V2", kind: "human", text: "上一轮的尾巴" }]);
    timeline.append(ROW("这一轮的第一句"));
    const turn = render([...timeline.entries()]);
    expect(turn.narrative).toContain(`[${SEED_CLOCK}] V2: 上一轮的尾巴`);
    expect(turn.current).toBe(`[${CLOCK}] V2: 这一轮的第一句`);
    expect(turn.current).not.toContain("上一轮的尾巴");
  });
});

describe("settled history projection", () => {
  /**
   * The whole point of the rebuilt carrier: a judged interval reaches the next request as its cooked
   * projection, never as the raw ASR text the judge already ruled on, and never twice.
   */
  it("renders a settled interval cooked, not raw", () => {
    const timeline = createTimeline({ now: () => NOW });
    const raw = timeline.append(ROW("嗯 那个 明天 天气"));
    (raw as { cookedRows?: unknown }).cookedRows = [{ speaker: "爸爸", text: "明天天气怎么样" }];
    const cursor = raw.id;
    timeline.append(ROW("那后天呢"));

    const turn = render([...timeline.entries()], cursor);
    expect(turn.narrative).toBe(
      ["[HISTORY]", `[${CLOCK}] 爸爸: 明天天气怎么样`, "[/HISTORY]"].join("\n")
    );
    expect(turn.narrative).not.toContain("嗯 那个");
    expect(turn.current).toBe(`[${CLOCK}] V2: 那后天呢`);
  });

  it("carries every cooked row of a merged interval, in order", () => {
    const timeline = createTimeline({ now: () => NOW });
    const raw = timeline.append(ROW("第一件事 第二件事"));
    (raw as { cookedRows?: unknown }).cookedRows = [
      { speaker: "V1", text: "第一件事" },
      { speaker: "V2", text: "第二件事" }
    ];
    const cursor = raw.id;
    timeline.append(ROW("继续"));

    expect(render([...timeline.entries()], cursor).narrative.split("\n")).toEqual([
      "[HISTORY]",
      `[${CLOCK}] V1: 第一件事`,
      `[${CLOCK}] V2: 第二件事`,
      "[/HISTORY]"
    ]);
  });

  it("contributes nothing for a settled interval the judge found unintelligible", () => {
    const timeline = createTimeline({ now: () => NOW });
    const raw = timeline.append(ROW("嗯 啊 那个"));
    (raw as { cookedRows?: unknown }).cookedRows = [];
    const cursor = raw.id;
    timeline.append(ROW("换个话题"));

    expect(render([...timeline.entries()], cursor).narrative).toBe("");
  });

  it("starts history at the stable boundary", () => {
    const timeline = createTimeline({ now: () => NOW });
    for (let index = 0; index < 6; index += 1) {
      const raw = timeline.append(ROW(`raw-${index}`));
      (raw as { cookedRows?: unknown }).cookedRows = [{ speaker: "V1", text: `line-${index}` }];
    }
    const cursor = timeline.entries().at(-1)!.id;
    timeline.append(ROW("当前这句"));

    const lines = render([...timeline.entries()], cursor, 2).narrative.split("\n");
    expect(lines).toEqual([
      "[HISTORY]",
      `[${CLOCK}] V1: line-2`,
      `[${CLOCK}] V1: line-3`,
      `[${CLOCK}] V1: line-4`,
      `[${CLOCK}] V1: line-5`,
      "[/HISTORY]"
    ]);
  });

  it("has no history block before anything has settled", () => {
    expect(render(drain([ROW("开场第一句")])).narrative).toBe("");
  });

  it("keeps seeded rows after the boundary", () => {
    const timeline = createTimeline({ now: () => NOW });
    timeline.seedLog(
      Array.from({ length: 8 }, (_, index) => ({
        at: new Date(NOW + index * 1_000).toISOString(),
        speaker: "V1",
        kind: "human",
        text: `seed-${index}`
      }))
    );
    timeline.append(ROW("当前这句"));

    const lines = render([...timeline.entries()], 0, 3).narrative.split("\n");
    expect(lines.slice(1, -1)).toEqual([
      `[${new Date(NOW + 3_000).toTimeString().slice(0, 8)}] V1: seed-3`,
      `[${new Date(NOW + 4_000).toTimeString().slice(0, 8)}] V1: seed-4`,
      `[${new Date(NOW + 5_000).toTimeString().slice(0, 8)}] V1: seed-5`,
      `[${new Date(NOW + 6_000).toTimeString().slice(0, 8)}] V1: seed-6`,
      `[${new Date(NOW + 7_000).toTimeString().slice(0, 8)}] V1: seed-7`
    ]);
  });

  /**
   * History is ordered by timeline id, not by which bucket a line came from. An earlier version
   * collected drained `log` rows and settled rows separately and concatenated seeded-then-settled,
   * which inverted the block whenever seeding followed a settled interval. Production cannot reach
   * that today — `syncKnowledge` seeds once per generation on an empty timeline — so this cell
   * exists to stop the renderer depending on an invariant that lives in another file.
   */
  it("orders history by timeline id even when a seed lands after a settled interval", () => {
    const timeline = createTimeline({ now: () => NOW });
    const settled = timeline.append(ROW("raw"));
    (settled as { cookedRows?: unknown }).cookedRows = [{ speaker: "V1", text: "先settle的" }];
    const cursor = settled.id;
    timeline.seedLog([{ at: new Date(NOW).toISOString(), speaker: "V1", text: "后seed的" }]);
    timeline.append(ROW("当前这句"));

    expect(
      render([...timeline.entries()], cursor)
        .narrative.split("\n")
        .slice(1, -1)
    ).toEqual([`[${CLOCK}] V1: 先settle的`, `[${CLOCK}] V1: 后seed的`]);
  });
});
