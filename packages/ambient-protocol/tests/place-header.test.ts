// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ambientPlaceOf,
  decodePlaceHeader,
  encodePlaceHeader,
  PLACE_HEADER,
  type AmbientPlace
} from "../src/index";

const PLACE: AmbientPlace = {
  name: "望京 SOHO",
  area: "北京市朝阳区望京",
  arrived: "2026-10-20T14:02:00+08:00",
  previous: { name: "回龙观", area: "北京市昌平区" }
};

describe("place header", () => {
  it("is named X-Ambient-Place", () => {
    expect(PLACE_HEADER).toBe("X-Ambient-Place");
  });

  it("round-trips a place as percent-encoded UTF-8 JSON, with or without previous", () => {
    const raw = encodePlaceHeader(PLACE);
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(decodePlaceHeader(raw)).toEqual(PLACE);
    const first = { name: "a", area: "b", arrived: "2026-10-20T06:02Z" };
    expect(decodePlaceHeader(encodePlaceHeader(first))).toEqual(first);
  });

  it("accepts any explicit offset and an optional fraction", () => {
    for (const arrived of [
      "2026-10-20T06:02:00Z",
      "2026-10-20T06:02:00.123-07:00",
      "2026-10-20T14:02+08:00"
    ]) {
      expect(ambientPlaceOf({ name: "a", area: "b", arrived })).not.toBeNull();
    }
  });

  it("drops unknown keys instead of refusing them", () => {
    const raw = encodeURIComponent(
      JSON.stringify({ ...PLACE, lat: 1, previous: { ...PLACE.previous, extra: true } })
    );
    expect(decodePlaceHeader(raw)).toEqual(PLACE);
  });

  it.each([
    ["not percent-encoded JSON", "{"],
    ["a broken escape", "%E0%A4%A"],
    ["an array", encodeURIComponent("[]")],
    ["a missing name", encodeURIComponent(JSON.stringify({ ...PLACE, name: undefined }))],
    ["an empty area", encodeURIComponent(JSON.stringify({ ...PLACE, area: " " }))],
    ["a numeric name", encodeURIComponent(JSON.stringify({ ...PLACE, name: 3 }))],
    [
      "a time without offset",
      encodeURIComponent(JSON.stringify({ ...PLACE, arrived: "2026-10-20T14:02:00" }))
    ],
    ["a date only", encodeURIComponent(JSON.stringify({ ...PLACE, arrived: "2026-10-20" }))],
    [
      "an impossible time",
      encodeURIComponent(JSON.stringify({ ...PLACE, arrived: "2026-13-40T25:61:00Z" }))
    ],
    [
      "a previous without area",
      encodeURIComponent(JSON.stringify({ ...PLACE, previous: { name: "x" } }))
    ],
    ["a previous that is a string", encodeURIComponent(JSON.stringify({ ...PLACE, previous: "x" }))]
  ])("refuses %s", (_label, raw) => {
    expect(decodePlaceHeader(raw)).toBeNull();
  });
});
