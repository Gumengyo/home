import { createMusicMiddleware } from "./music.mjs";

export function createVercelMusicHandler(env = process.env, options = {}) {
  const middleware = createMusicMiddleware({ ...env, VERCEL: "1" }, options);
  return (request, response) =>
    middleware(request, response, () => {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ message: "接口不存在" }));
    });
}
