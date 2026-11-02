import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const excludedIPv6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  excludedIPv6.addSubnet(address, prefix, "ipv6");
}

function privateAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    return !globalIPv6.check(ip, "ipv6") || excludedIPv6.check(ip, "ipv6");
  }
  return true;
}

export async function validateMediaUrl(input, resolver = lookup) {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    /(?:^|\.)(?:localhost|local|internal)$/i.test(hostname)
  ) {
    throw new Error("Unsupported media URL");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Unsupported media address");
  }
  return { url, addresses };
}

function openMedia({ url, addresses }, request, response) {
  return new Promise((resolve, reject) => {
    // Pin the checked addresses to the actual socket to prevent DNS rebinding.
    const outgoing = (url.protocol === "https:" ? https : http).request(url, {
      agent: false,
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: {
        "Accept-Encoding": "identity",
        ...(request.headers.range ? { Range: request.headers.range } : {}),
      },
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    });
    const abort = () => outgoing.destroy();
    response.once("close", abort);
    outgoing.once("close", () => response.off("close", abort));
    outgoing.setTimeout(15000, () => outgoing.destroy(new Error("Media timeout")));
    outgoing.once("error", reject);
    outgoing.once("response", resolve);
    outgoing.end();
  });
}

export function createMediaRelay({ validate = validateMediaUrl, open = openMedia } = {}) {
  return async (input, request, response) => {
    const range = request.headers.range;
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      response.writeHead(416).end();
      return;
    }
    let url = input;
    for (let redirects = 0; redirects < 4; redirects++) {
      const checked = await validate(url);
      const upstream = await open(checked, request, response);
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
        const location = upstream.headers.location;
        upstream.destroy();
        if (!location) throw new Error("Invalid media redirect");
        url = new URL(location, checked.url).href;
        continue;
      }
      const contentType = upstream.headers["content-type"] || "application/octet-stream";
      if (
        ![200, 206, 416].includes(upstream.statusCode) ||
        (upstream.statusCode !== 416 &&
          !/^(audio\/|video\/mp4(?:;|$)|application\/(?:octet-stream|ogg)(?:;|$))/i.test(
            contentType,
          ))
      ) {
        upstream.destroy();
        throw new Error("Invalid media response");
      }
      response.statusCode = upstream.statusCode;
      response.setHeader("Content-Type", contentType);
      for (const name of ["content-length", "content-range", "accept-ranges"]) {
        if (upstream.headers[name]) response.setHeader(name, upstream.headers[name]);
      }
      if (request.method === "HEAD" || upstream.statusCode === 416) {
        upstream.destroy();
        response.end();
      } else {
        await pipeline(upstream, response);
      }
      return;
    }
    throw new Error("Too many media redirects");
  };
}
