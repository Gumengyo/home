import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVercelMusicHandler } from "../server/vercel.mjs";
import { config } from "../api/music.mjs";

const secret = "vercel-test-server-secret";
async function functionServer(t, env = {}, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "home-vercel-test-"));
  t.after(() => {
    assert.ok(cwd.startsWith(join(tmpdir(), "home-vercel-test-")));
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(
    join(cwd, "music.playlist.json"),
    JSON.stringify([{ source: "wy", songId: "123", name: "Cloud playlist", artist: "Test" }]),
  );
  writeFileSync(join(cwd, ".env.local"), `MUSIC_API_KEY=${secret}\n`);
  let resolves = 0;
  const handler = createVercelMusicHandler(
    {
      MUSIC_API_URL: "https://source.example.test",
      MUSIC_API_KEY: secret,
      LINYU_ENV_FILE: "D:/not-present/linyu/.env",
      ...env,
    },
    {
      cwd,
      relay: options.relay,
      fetcher: async (_url, init) => {
        resolves++;
        assert.equal(init.headers["X-API-Key"], secret);
        return Response.json({
          code: 200,
          url: options.media || "https://media.example.test/a.mp3",
        });
      },
    },
  );
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    request: (path, init = {}) => fetch(base + path, { redirect: "manual", ...init }),
    resolves: () => resolves,
  };
}

test("Vercel function uses the bundled playlist and ignores local Linyu paths", async (t) => {
  const app = await functionServer(t);
  const response = await app.request("/api/music/list");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data[0].name, "Cloud playlist");
  assert.equal(data[0].url, "/api/music/play/0");
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal((await app.request("/api/music/play/0")).status, 302);
  assert.equal((await app.request("/api/music/play/0")).status, 302);
  assert.equal(app.resolves(), 1);
  assert.equal((await app.request("/unknown")).status, 404);
});

test("Vercel requires server env settings instead of reading .env.local", async (t) => {
  const app = await functionServer(t, { MUSIC_API_KEY: "" });
  const response = await app.request("/api/music/list");
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(secret), false);
});

test("Vercel handler streams audio with Range headers without buffering the file", async (t) => {
  const app = await functionServer(
    t,
    {},
    {
      media: "http://media.example.test/a.mp3",
      relay: async (_url, request, response) => {
        assert.equal(request.headers.range, "bytes=0-4");
        response.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-4/100" });
        Readable.from([Buffer.from("audio")]).pipe(response);
      },
    },
  );
  const response = await app.request("/api/music/play/0", { headers: { Range: "bytes=0-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-4/100");
  assert.equal(await response.text(), "audio");
});

test("Vercel deployment includes the playlist and exposes a streaming Node function", () => {
  const manifest = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const playlist = JSON.parse(
    readFileSync(new URL("../music.playlist.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.buildCommand, "npm run build:vercel");
  assert.ok(manifest.functions["api/music.mjs"].includeFiles.includes("music.playlist.json"));
  assert.ok(manifest.functions["api/music.mjs"].excludeFiles.includes(".env"));
  assert.ok(
    manifest.rewrites.some(
      (route) => route.source === "/api/music/:path*" && route.destination === "/api/music.mjs",
    ),
  );
  assert.ok(playlist.length > 0 && playlist.length <= 200);
  assert.equal(config.supportsResponseStreaming, true);
});
