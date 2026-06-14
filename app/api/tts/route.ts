/**
 * Text-to-speech for Ignis's spoken lines.
 *
 * Takes { text, voice? } (see TtsRequest in app/lib/types) and streams back audio bytes
 * (audio/mpeg) for the client to play through an AudioContext + AnalyserNode.
 *
 * Why a direct OpenAI call and not the AI Gateway: the Vercel AI Gateway does not
 * expose speech models (its provider has languageModel/embedding/image/video/reranking
 * only, and /v1/models lists no tts/speech models), so speech must go to a provider
 * directly. We hit OpenAI's /v1/audio/speech, which returns the audio as a binary body
 * we can pass straight through — no extra dependency, and first bytes arrive sooner than
 * buffering the whole clip. The API key stays server-side; the browser never sees it.
 */
import type { TtsRequest } from "@/app/lib/types";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
export const maxDuration = 30;

/** OpenAI TTS endpoint. gpt-4o-mini-tts is the current model and supports `instructions`
 *  (tone/affect); "nova" is the project's default voice (TtsRequest.voice). mp3 is the
 *  default response_format and decodes everywhere, iOS Safari included. */
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "nova";

/** Keeps Ignis in character; gpt-4o-mini-tts honours this, older tts-1 models ignore it. */
const VOICE_INSTRUCTIONS =
  "You are Ignis, a living flame: warm, intimate, and calm, with a faint crackle of fire. Speak naturally, like a short spoken line, never rushed.";

/** Guard against accidental huge bills / latency from a runaway prompt. */
const MAX_TEXT_LENGTH = 4096;

export const POST = withRoute("tts", postHandler);

async function postHandler(req: Request): Promise<Response> {
  // Same boundary as /api/stt: only an authenticated user can spend our TTS budget.
  try {
    await verifyUser(req);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Don't crash the app if the key is absent — fail clearly and let the client
    // fall back to silent captions. Requires env var OPENAI_API_KEY (server-only).
    return Response.json(
      { error: "TTS is not configured (missing OPENAI_API_KEY)." },
      { status: 503 },
    );
  }

  let body: TtsRequest;
  try {
    body = (await req.json()) as TtsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ error: "`text` is required." }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `\`text\` exceeds ${MAX_TEXT_LENGTH} characters.` },
      { status: 413 },
    );
  }

  const voice =
    typeof body.voice === "string" && body.voice.trim()
      ? body.voice.trim()
      : DEFAULT_VOICE;

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice,
        instructions: VOICE_INSTRUCTIONS,
        response_format: "mp3",
      }),
      signal: req.signal,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "TTS upstream request failed." },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    // Surface the provider's error text (it's JSON on failure) without leaking the key.
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: "TTS provider error.", status: upstream.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  // Stream the audio straight through to the client.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
