// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createAmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";

it("serves all V6 poses as native SVG with the matching accessible state label", async () => {
  const labels = {
    listening: "在听",
    heard: "听到了",
    received: "正在送达",
    thinking: "思考中",
    tool: "使用工具",
    generating: "准备发声",
    reply: "回复已生成",
    tts: "播报中",
    muted: "暂停收音",
    sensesoff: "收音已关闭",
    deaf: "暂时听不见",
    offline: "断线"
  };
  const webDir = fileURLToPath(new URL("../web", import.meta.url));
  const gateway = { rooms: [], room: () => undefined } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({ gateway, webDir });
  const address = await server.listen(0);
  try {
    for (const [state, label] of Object.entries(labels)) {
      for (const theme of ["dark", "paper", "mono"]) {
        const name = `avatar/${state}-${theme}.svg`;
        const response = await fetch(`http://127.0.0.1:${address.port}/${name}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        const svg = await response.text();
        expect(svg).toBe(readFileSync(`${webDir}/${name}`, "utf8"));
        expect(svg).toContain(`<title>多多 · ${label}</title>`);
        expect(svg).not.toMatch(/<image|<script|<filter/);
      }
    }
  } finally {
    await server.close();
  }
});
