import { createVercelMusicHandler } from "../server/vercel.mjs";

export const config = { supportsResponseStreaming: true };

let handler;
export default function music(request, response) {
  // Reuse resolver cache on warm instances; no local source files or keys are bundled.
  handler ||= createVercelMusicHandler();
  return handler(request, response);
}
