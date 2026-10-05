// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createPersistedSpeakerSpaceFactory } from "../../src/speaker/identity-space";

const MEASURED = ["enc-a", "enc-a-cpu"];

function memoryFs(): {
  files: Map<string, string>;
  readFile: (file: string) => string;
  writeFile: (file: string, text: string) => void;
} {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (file) => {
      const text = files.get(file);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      }
      return text;
    },
    writeFile: (file, text) => {
      files.set(file, text);
    }
  };
}

function factory(served: () => string | null, logs: string[] = []) {
  const fs = memoryFs();
  const spaceFor = createPersistedSpeakerSpaceFactory({
    dataDir: "/data",
    resolveModel: async () => served(),
    measuredModels: MEASURED,
    onLog: (message) => {
      logs.push(message);
    },
    readFile: fs.readFile,
    writeFile: fs.writeFile
  });
  return { fs, spaceFor, logs };
}

describe("persisted speaker space and the measured-model guard", () => {
  it("prepares and mints against a served model with a measured operating point", async () => {
    const { spaceFor, fs } = factory(() => "enc-a");
    const space = spaceFor("room");
    await space.prepare();
    expect(space.modelReady()).toBe(true);
    expect(space.issueV([1, 0, 0])).toBe("V1");
    expect(space.vPeople()).toHaveLength(1);
    expect([...fs.files.values()].some((raw) => raw.includes('"model":"enc-a"'))).toBe(true);
  });

  it("refuses to number rows when the served model has no measured operating point", async () => {
    const logs: string[] = [];
    let served = "enc-a";
    const { spaceFor, fs } = factory(() => served, logs);
    const space = spaceFor("room");
    await space.prepare();
    space.issueV([1, 0, 0]);
    const before = new Map(fs.files);

    served = "enc-unmeasured";
    await space.prepare();
    expect(space.modelReady()).toBe(false);
    expect(space.vPeople()).toEqual([]);
    expect(space.issueV([0, 1, 0])).toBeNull();
    expect(logs).toContain("speaker served model has no measured operating point");
    // Neither archived nor transitioned: the pool on disk is exactly what it was.
    expect(fs.files).toEqual(before);
    expect(logs).not.toContain("speaker voice pool archived for model change");

    // The same anchors come back once the measured encoder is served again.
    served = "enc-a";
    await space.prepare();
    expect(space.modelReady()).toBe(true);
    expect(space.vPeople().map((voice) => voice.id)).toEqual(["V1"]);
  });

  it("still archives and renumbers when moving between two measured models", async () => {
    const logs: string[] = [];
    let served = "enc-a";
    const { spaceFor, fs } = factory(() => served, logs);
    const space = spaceFor("room");
    await space.prepare();
    space.issueV([1, 0, 0]);

    served = "enc-a-cpu";
    await space.prepare();
    expect(space.modelReady()).toBe(true);
    expect(space.vPeople()).toEqual([]);
    expect(logs).toContain("speaker voice pool archived for model change");
    expect([...fs.files.keys()].some((file) => file.includes(".bak-"))).toBe(true);
    expect(space.issueV([0, 1, 0])).toBe("V2");
  });
});
