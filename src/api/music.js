import fetchJsonp from "fetch-jsonp";

async function requestList(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || `歌单请求失败（${response.status}）`);
  if (!Array.isArray(data) || !data.length) throw new Error("歌单为空或返回格式不正确");
  return data;
}

// Dependencies are injectable so both providers can be checked without real credentials.
export async function getPlayerList(
  server,
  type,
  id,
  { env = import.meta.env || {}, fetcher = fetch, jsonp = fetchJsonp } = {},
) {
  const provider = env.VITE_SONG_PROVIDER || "meting";
  let data;
  if (provider === "linyu") {
    data = await requestList("/api/music/list", fetcher);
  } else if (provider === "meting") {
    const endpoint = new URL(env.VITE_SONG_API, globalThis.location?.href);
    endpoint.searchParams.set("server", server);
    endpoint.searchParams.set("type", type);
    endpoint.searchParams.set("id", id);
    data = await requestList(endpoint.href, fetcher);
    if (typeof data[0]?.url === "string" && data[0].url.startsWith("@")) {
      const [, callback, , url] = data[0].url.split("@").slice(1);
      const jsonpData = await jsonp(url, { jsonpCallback: callback || "callback" }).then((res) =>
        res.json(),
      );
      const result = jsonpData?.req_0?.data;
      const domain = (
        result?.sip?.find((value) => !value.startsWith("http://ws")) || result?.sip?.[0]
      )?.replace(/^http:/, "https:");
      if (!domain || !Array.isArray(result?.midurlinfo)) throw new Error("QQ 音乐返回格式不正确");
      data = data.map((track, index) => ({
        ...track,
        url: result.midurlinfo[index]?.purl ? domain + result.midurlinfo[index].purl : "",
      }));
    }
  } else {
    throw new Error(`不支持的音源模式：${provider}`);
  }
  const playlist = data
    .filter((track) => track && typeof track.url === "string" && track.url)
    .map((track) => ({
      name: track.name || track.title || "未命名歌曲",
      artist: track.artist || track.author || "未知歌手",
      url: track.url,
      cover: track.cover || track.pic || "",
      lrc: track.lrc || "",
    }));
  if (!playlist.length) throw new Error("歌单中没有可播放的歌曲");
  return playlist;
}
