import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHomeServer } from "../server/index.mjs";
import { createMediaRelay, validateMediaUrl } from "../server/media.mjs";
import { loadMusicConfig } from "../server/music.mjs";
import { getPlayerList } from "../src/api/music.js";

const secret = "test-private-source-key";
const tracks = [
  { source: "wy", songId: "347230", name: "海阔天空", artist: "Beyond", lrc: "[00:01.00]歌词" },
];

function fixture(t, env = {}, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "home-music-test-"));
  t.after(() => {
    assert.ok(cwd.startsWith(join(tmpdir(), "home-music-test-")));
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, "music.example.json"), JSON.stringify(options.tracks || tracks));
  const settings = {
    MUSIC_API_URL: "https://source.example.test/v1",
    MUSIC_API_KEY: secret,
    ...env,
  };
  return { cwd, settings };
}

async function gateway(t, env = {}, options = {}) {
  const { cwd, settings } = fixture(t, env, options);
  const calls = [];
  let time = 1000;
  const server = createHomeServer(settings, {
    cwd,
    dist: cwd,
    now: () => time,
    relay: options.relay,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return options.fetcher
        ? options.fetcher(url, init)
        : Response.json({ code: 200, url: "https://media.example.test/track.mp3" });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    cwd,
    advance: () => {
      time += 31_000;
    },
    request: (path, init = {}) => fetch(base + path, { redirect: "manual", ...init }),
  };
}

test("public playlist contains stable local URLs and never returns the source key", async (t) => {
  const app = await gateway(t);
  const response = await app.request("/api/music/list");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const list = await response.json();
  assert.equal(list[0].url, "/api/music/play/0");
  assert.equal(list[0].lrc, "/api/music/lyrics/0");
  assert.equal(JSON.stringify(list).includes(secret), false);
  assert.equal(app.calls.length, 0);
  assert.equal(await (await app.request(list[0].lrc)).text(), tracks[0].lrc);
});

test("playback uses Linyu's upstream contract, caches briefly and refreshes expired links", async (t) => {
  const app = await gateway(t);
  const response = await app.request("/api/music/play/0");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://media.example.test/track.mp3");
  assert.equal(app.calls[0].url.pathname, "/v1/music/url");
  assert.deepEqual(Object.fromEntries(app.calls[0].url.searchParams), {
    source: "wy",
    songId: "347230",
    quality: "320k",
  });
  assert.equal(app.calls[0].init.headers["X-API-Key"], secret);
  assert.equal(app.calls[0].init.redirect, "error");
  await app.request("/api/music/play/0");
  assert.equal(app.calls.length, 1);
  app.advance();
  await app.request("/api/music/play/0");
  assert.equal(app.calls.length, 2);
});

test("unlisted IDs, arbitrary URLs and write requests cannot call the source", async (t) => {
  const app = await gateway(t);
  for (const path of [
    "/api/music/play/99",
    "/api/music/play/-1",
    "/api/music/play/00",
    "/api/music/url?url=http://localhost",
    "/api/music/play/wy/123",
  ]) {
    assert.equal((await app.request(path)).status, 404);
  }
  assert.equal((await app.request("/api/music/list", { method: "POST" })).status, 405);
  assert.equal(app.calls.length, 0);
});

test("concurrent playback requests resolve a track only once", async (t) => {
  const app = await gateway(
    t,
    {},
    {
      fetcher: async () => {
        await new Promise((done) => setTimeout(done, 25));
        return Response.json({ code: 0, url: "https://media.example.test/a.mp3" });
      },
    },
  );
  const responses = await Promise.all([
    app.request("/api/music/play/0"),
    app.request("/api/music/play/0"),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [302, 302],
  );
  assert.equal(app.calls.length, 1);
});

test("upstream errors, unsupported media and credential-bearing media do not leak to visitors", async (t) => {
  for (const data of [
    { code: 403, message: secret, url: "https://media.example.test/a" },
    { code: 200, url: "file:///private/audio.mp3" },
    { code: 200, url: `https://media.example.test/a?key=${secret}` },
    { code: 200, url: `https://media.example.test/a?key=${encodeURIComponent(secret)}` },
  ]) {
    const app = await gateway(t, {}, { fetcher: async () => Response.json(data) });
    const response = await app.request("/api/music/play/0");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
    assert.equal((await response.text()).includes(secret), false);
  }
});

test("source rate limits remain retryable", async (t) => {
  const app = await gateway(t, {}, { fetcher: async () => new Response(secret, { status: 429 }) });
  assert.equal((await app.request("/api/music/play/0")).status, 429);
});

function mediaResponse(statusCode, headers = {}, body = "audio") {
  const stream = Readable.from([Buffer.from(body)]);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test("HTTP media is streamed on the home origin and preserves Range/206 and HEAD", async (t) => {
  const calls = [];
  const relay = createMediaRelay({
    validate: async (input) => ({ url: new URL(input), addresses: [] }),
    open: async ({ url }, request) => {
      calls.push({ protocol: url.protocol, range: request.headers.range, method: request.method });
      return mediaResponse(206, {
        "content-type": "audio/mpeg",
        "content-length": "5",
        "content-range": "bytes 0-4/100",
        "accept-ranges": "bytes",
      });
    },
  });
  const app = await gateway(
    t,
    {},
    {
      relay,
      fetcher: async () => Response.json({ code: 200, url: "http://media.example.test/audio.mp3" }),
    },
  );
  const response = await app.request("/api/music/play/0", { headers: { Range: "bytes=0-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-4/100");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("location"), null);
  assert.equal(await response.text(), "audio");
  assert.deepEqual(calls[0], { protocol: "http:", range: "bytes=0-4", method: "GET" });
  const head = await app.request("/api/music/play/0", { method: "HEAD" });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), "");
  assert.equal(calls[1].method, "HEAD");
  const invalid = await app.request("/api/music/play/0", { headers: { Range: "bytes=0-1,5-6" } });
  assert.equal(invalid.status, 416);
  assert.equal(calls.length, 2);
});

test("media validation rejects private, mapped, mixed-DNS and unexpected-port targets", async () => {
  for (const url of [
    "http://127.0.0.1/a",
    "http://169.254.169.254/a",
    "http://10.0.0.1/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "http://[2001::1]/a",
    "http://[2001:db8::1]/a",
    "http://[2002:7f00:1::]/a",
    "http://localhost/a",
    "http://example.local/a",
    "http://example.test:3307/a",
    "file:///audio",
  ]) {
    await assert.rejects(validateMediaUrl(url));
  }
  await assert.rejects(
    validateMediaUrl("http://media.example.test/a", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]),
  );
  const checked = await validateMediaUrl("http://media.example.test/a", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(checked.addresses[0].address, "8.8.8.8");
});

test("HTTP media redirects are revalidated before connecting", async (t) => {
  let opens = 0;
  const relay = createMediaRelay({
    validate: (url) => validateMediaUrl(url, async () => [{ address: "8.8.8.8", family: 4 }]),
    open: async () => {
      opens++;
      return mediaResponse(302, { location: "http://127.0.0.1/private" });
    },
  });
  const app = await gateway(
    t,
    {},
    {
      relay,
      fetcher: async () => Response.json({ code: 200, url: "http://media.example.test/a" }),
    },
  );
  assert.equal((await app.request("/api/music/play/0")).status, 502);
  assert.equal(opens, 1);
});

test("HTTP relay forwards 416 and rejects non-audio upstream content", async (t) => {
  for (const status of [416, 200]) {
    const relay = createMediaRelay({
      validate: async (url) => ({ url: new URL(url), addresses: [] }),
      open: async () =>
        mediaResponse(
          status,
          status === 416 ? { "content-range": "bytes */100" } : { "content-type": "text/html" },
        ),
    });
    const app = await gateway(
      t,
      {},
      {
        relay,
        fetcher: async () => Response.json({ code: 200, url: "http://media.example.test/a" }),
      },
    );
    const response = await app.request("/api/music/play/0");
    assert.equal(response.status, status === 416 ? 416 : 502);
    if (status === 416) assert.equal(response.headers.get("content-range"), "bytes */100");
  }
});

test("missing or invalid configuration fails without exposing the configuration", async (t) => {
  for (const env of [
    { MUSIC_API_KEY: "" },
    { MUSIC_QUALITIES: secret },
    { MUSIC_API_URL: `http://example.test/${secret}` },
  ]) {
    const app = await gateway(t, env);
    const response = await app.request("/api/music/list");
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes(secret), false);
  }
});

test("Linyu env import selects only source fields and explicit home settings take precedence", (t) => {
  const { cwd, settings } = fixture(t);
  writeFileSync(
    join(cwd, "linyu.env"),
    'MUSIC_API_URL=https://shared.example.test\nMUSIC_API_KEY=shared-key\nMYSQL_PASSWORD=database-secret\nMUSIC_QUALITIES={"wy":["128k"]}\n',
  );
  const config = loadMusicConfig({ ...settings, LINYU_ENV_FILE: "linyu.env" }, cwd);
  assert.equal(config.apiKey, secret);
  assert.equal(config.baseUrl, settings.MUSIC_API_URL);
  assert.equal(config.tracks[0].quality, "128k");
  assert.equal(JSON.stringify(config).includes("database-secret"), false);
  assert.throws(() => loadMusicConfig({ ...settings, MUSIC_QUALITIES: '{"wy":[]}' }, cwd));
});

test("all five Linyu platform ID formats can be configured", (t) => {
  const playlist = ["wy", "tx", "kw", "kg", "mg"].map((source, index) => ({
    ...tracks[0],
    source,
    songId: index === 1 ? "001abcMid" : "12345",
  }));
  const { cwd, settings } = fixture(t, {}, { tracks: playlist });
  assert.equal(loadMusicConfig(settings, cwd).tracks.length, 5);
});

test("production serves built files and rejects paths outside dist", async (t) => {
  const app = await gateway(t);
  writeFileSync(join(app.cwd, "index.html"), "<main>home</main>");
  assert.equal(await (await app.request("/")).text(), "<main>home</main>");
  assert.equal((await app.request("/", { method: "HEAD" })).status, 200);
  assert.equal((await app.request("/%2e%2e%2f.env")).status, 404);
  assert.equal((await app.request("/server/index.mjs")).status, 404);
});

test("Meting preserves query parameters, encodes IDs and normalizes old field names", async () => {
  let address;
  const list = await getPlayerList("netease", "playlist", "a&b", {
    env: { VITE_SONG_API: "https://meting.example.test/api?token=public-token" },
    fetcher: async (url) => {
      address = new URL(url);
      return Response.json([{ title: "歌曲", author: "歌手", pic: "cover", url: "audio" }]);
    },
  });
  assert.equal(address.searchParams.get("token"), "public-token");
  assert.equal(address.searchParams.get("id"), "a&b");
  assert.equal(list[0].name, "歌曲");
  assert.equal(list[0].artist, "歌手");
});

test("QQ JSONP URLs are normalized and tracks with no playable URL are skipped", async () => {
  const list = await getPlayerList("tencent", "playlist", "1", {
    env: { VITE_SONG_API: "https://meting.example.test" },
    fetcher: async () =>
      Response.json([
        { name: "QQ", url: "@handle@callback@fn@https://qq.example.test" },
        { name: "Unavailable", url: "@same" },
      ]),
    jsonp: async () => ({
      json: async () => ({
        req_0: {
          data: {
            sip: ["http://cdn.example.test/"],
            midurlinfo: [{ purl: "track.mp3" }, { purl: "" }],
          },
        },
      }),
    }),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].url, "https://cdn.example.test/track.mp3");
});

test("Linyu mode requests the local gateway and rejects empty/error responses", async () => {
  const env = { VITE_SONG_PROVIDER: "linyu" };
  const list = await getPlayerList("", "", "", {
    env,
    fetcher: async (url) => {
      assert.equal(url, "/api/music/list");
      return Response.json([{ name: "Home", url: "/api/music/play/0" }]);
    },
  });
  assert.equal(list[0].url, "/api/music/play/0");
  for (const response of [
    Response.json([]),
    Response.json({ message: "请检查配置" }, { status: 503 }),
    Response.json([null]),
  ]) {
    await assert.rejects(getPlayerList("", "", "", { env, fetcher: async () => response }));
  }
});
