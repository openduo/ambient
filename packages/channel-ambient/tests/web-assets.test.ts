// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createAmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";

/**
 * A missing module is a blank page: the browser loads `/app.js`, one bare import 404s, and nothing
 * runs. Walk both trees the page actually depends on — the stylesheet `@import` tree and the module
 * import graph — against the real server rather than the filesystem.
 */
it("serves the app and its complete stylesheet and module trees from the shipped web directory", async () => {
  const webDir = fileURLToPath(new URL("../web", import.meta.url));
  const gateway = { rooms: [], room: () => undefined } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({ gateway, webDir });
  const address = await server.listen(0);
  const origin = `http://127.0.0.1:${address.port}`;
  const seen = new Set<string>();

  async function stylesheet(url: string): Promise<void> {
    if (seen.has(url)) return;
    seen.add(url);
    expect(new URL(url).origin).toBe(origin);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    const css = await response.text();
    expect(css).not.toContain("@font-face");
    for (const match of css.matchAll(/@import url\(['"]([^'"]+)['"]\)/g)) {
      await stylesheet(new URL(match[1]!, url).href);
    }
  }

  async function script(url: string): Promise<void> {
    if (seen.has(url)) return;
    seen.add(url);
    expect(new URL(url).origin).toBe(origin);
    const response = await fetch(url);
    expect(response.status, `${url} is not served`).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const source = await response.text();
    for (const match of source.matchAll(/^import [^;]*? from "([^"]+)";$/gm)) {
      await script(new URL(match[1]!, url).href);
    }
  }

  try {
    const response = await fetch(origin + "/");
    expect(response.status).toBe(200);
    const html = await response.text();

    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)];
    expect(links.length, "the app ships exactly one stylesheet entry point").toBe(1);
    for (const match of links) await stylesheet(new URL(match[1]!, origin).href);

    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)];
    expect(scripts.length, "the page loads no script at all").toBeGreaterThan(0);
    for (const match of scripts) await script(new URL(match[1]!, origin).href);
    expect(seen.has(`${origin}/room-state.js`), "the module graph was never walked").toBe(true);

    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.files).toContain("web/");
  } finally {
    await server.close();
  }
});
