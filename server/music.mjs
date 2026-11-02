import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { createMediaRelay } from "./media.mjs";

const sources = new Set(["wy", "tx", "kw", "kg", "mg"]);
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const qualityPattern = /^[a-zA-Z0-9_]{1,24}$/;

class MusicError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function httpUrl(value, httpsOnly = false) {
  const url = new URL(value);
  if (
    !(httpsOnly ? ["https:"] : ["https:", "http:"]).includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid URL");
  }
  return url;
}

export function loadMusicConfig(env = process.env, cwd = process.cwd()) {
  // Read only source settings. Never execute or import code from the other project.
  const shared = env.LINYU_ENV_FILE
    ? parseEnv(readFileSync(resolve(cwd, env.LINYU_ENV_FILE), "utf8"))
    : {};
  const value = (name) => env[name] ?? shared[name] ?? "";
  const baseUrl = value("MUSIC_API_URL");
  if (baseUrl) {
    const url = httpUrl(baseUrl, true);
    if (url.search || url.hash) throw new Error("Invalid source base URL");
  }
  const qualities = value("MUSIC_QUALITIES") ? JSON.parse(value("MUSIC_QUALITIES")) : null;
  if (qualities !== null && (typeof qualities !== "object" || Array.isArray(qualities))) {
    throw new Error("Invalid source qualities");
  }
  if (qualities) {
    for (const [source, options] of Object.entries(qualities)) {
      if (
        !sources.has(source) ||
        !Array.isArray(options) ||
        options.length > 16 ||
        options.some((q) => typeof q !== "string" || !qualityPattern.test(q))
      ) {
        throw new Error("Invalid source qualities");
      }
    }
  }
  const playlist = JSON.parse(
    readFileSync(resolve(cwd, env.MUSIC_PLAYLIST_FILE || "music.example.json"), "utf8"),
  );
  if (!Array.isArray(playlist) || !playlist.length || playlist.length > 200) {
    throw new Error("Playlist must contain 1–200 tracks");
  }
  const tracks = playlist.map((track) => {
    if (
      !track ||
      !sources.has(track.source) ||
      !idPattern.test(String(track.songId ?? "")) ||
      typeof track.name !== "string" ||
      !track.name.trim()
    ) {
      throw new Error("Invalid playlist track");
    }
    const options = qualities?.[track.source];
    const preferred = track.quality || env.MUSIC_QUALITY || "320k";
    const quality =
      !track.quality && !env.MUSIC_QUALITY && options?.length && !options.includes(preferred)
        ? options[0]
        : preferred;
    if (!qualityPattern.test(quality) || (qualities && !options?.includes(quality))) {
      throw new Error("Track quality is unavailable for this source");
    }
    // Only these public fields are allowed into the response.
    return {
      source: track.source,
      songId: String(track.songId),
      quality,
      name: track.name.trim().slice(0, 200),
      artist: String(track.artist || "未知歌手").slice(0, 200),
      cover: track.cover ? httpUrl(track.cover).href : "",
      lrc: typeof track.lrc === "string" ? track.lrc : "",
    };
  });
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey: value("MUSIC_API_KEY"), tracks };
}

export function createMusicMiddleware(
  env = process.env,
  { cwd = process.cwd(), fetcher = fetch, now = Date.now, relay = createMediaRelay() } = {},
) {
  let config;
  try {
    config = loadMusicConfig(env, cwd);
  } catch {
    // Do not expose file contents, parse errors, URLs or credentials to visitors.
    config = null;
  }
  const cache = new Map();
  const pending = new Map();
  async function resolveTrack(index) {
    const hit = cache.get(index);
    if (hit?.expires > now()) return hit.url;
    if (pending.has(index)) return pending.get(index);
    const task = (async () => {
      const { source, songId, quality } = config.tracks[index];
      const endpoint = new URL(`${config.baseUrl}/music/url`);
      endpoint.search = new URLSearchParams({ source, songId, quality });
      const response = await fetcher(endpoint, {
        headers: {
          "X-API-Key": config.apiKey,
          "X-Request-ID": randomUUID(),
          "User-Agent": "home-music/4.1",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new MusicError(
          response.status === 429 ? "音源请求过快，请稍后再试" : "音源请求失败，请检查服务端配置",
          response.status === 429 ? 429 : 502,
        );
      }
      const data = await response.json();
      if (Number(data?.code) === 429) throw new MusicError("音源请求过快，请稍后再试", 429);
      if (![0, 200].includes(Number(data?.code)) || typeof data.url !== "string") {
        throw new MusicError("音源未返回可播放链接，请检查平台和音质权限");
      }
      const url = httpUrl(data.url).href;
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        /* Compare the original URL too. */
      }
      if (url.includes(config.apiKey) || decoded.includes(config.apiKey)) {
        throw new MusicError("播放链接包含音源凭据，已停止返回");
      }
      cache.set(index, { url, expires: now() + 30_000 });
      return url;
    })();
    pending.set(index, task);
    try {
      return await task;
    } finally {
      pending.delete(index);
    }
  }

  return async (request, response, next = () => {}) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/api/music" && !url.pathname.startsWith("/api/music/")) return next();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, data) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(data));
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD");
      return send(405, { message: "请求方法不支持" });
    }
    if (!config) return send(503, { message: "音源配置或歌单格式不正确，请检查服务端配置" });
    if (!config.baseUrl || !config.apiKey)
      return send(503, { message: "尚未配置 MUSIC_API_URL 和 MUSIC_API_KEY" });
    try {
      if (url.pathname === "/api/music/list") {
        return send(
          200,
          config.tracks.map(({ name, artist, cover, lrc }, index) => ({
            name,
            artist,
            cover,
            lrc: /^https?:\/\//.test(lrc) ? httpUrl(lrc).href : `/api/music/lyrics/${index}`,
            url: `/api/music/play/${index}`,
          })),
        );
      }
      const lyricMatch = /^\/api\/music\/lyrics\/(0|[1-9]\d{0,2})$/.exec(url.pathname);
      if (lyricMatch && config.tracks[Number(lyricMatch[1])]) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        return response.end(
          request.method === "HEAD"
            ? undefined
            : config.tracks[Number(lyricMatch[1])].lrc || "[00:00.00]暂无歌词",
        );
      }
      const match = /^\/api\/music\/play\/(0|[1-9]\d{0,2})$/.exec(url.pathname);
      if (!match || !config.tracks[Number(match[1])]) return send(404, { message: "歌曲不存在" });
      // Visitors can only resolve the owner's configured playlist, not arbitrary IDs or URLs.
      const media = await resolveTrack(Number(match[1]));
      if (media.startsWith("http:")) return await relay(media, request, response);
      response.statusCode = 302;
      response.setHeader("Location", media);
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      send(error instanceof MusicError ? error.status : 502, {
        message: error instanceof MusicError ? error.message : "暂时无法连接音源，请稍后重试",
      });
    }
  };
}
