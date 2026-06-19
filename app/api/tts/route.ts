/**
 * Text-to-speech for Ignis's spoken lines — ElevenLabs.
 *
 * Takes { text, voice? } (voice = an app voice id from app/lib/voices, default alien-3) and
 * returns JSON { audio (base64 mp3), words } via ElevenLabs' with-timestamps endpoint: per-word
 * timings let the client reveal the caption word-by-word in time with the audio. We use the
 * eleven_flash_v2_5 model: ~75ms latency and ~half the per-character cost — the right fit for the
 * client's per-sentence voice pipeline.
 *
 * The designed character voices (alien / wizard / pirate) live in the ElevenLabs library; we
 * reference them by voice_id (not secret). The API key (ELEVENLABS_API_KEY) stays server-side.
 */
import type { TtsRequest } from "@/app/lib/types";
import type { TtsResponse, TtsWord } from "@/app/lib/voice";
import { resolveVoice } from "@/app/lib/voices";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
export const maxDuration = 30;

/** eleven_flash_v2_5: ultra-low latency (~75ms) and ~0.5 credit/char. mp3 decodes everywhere. */
const TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_LENGTH = 4096;

const speechUrl = (voiceId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${OUTPUT_FORMAT}`;

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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    // Fail clearly; the client falls back to a silent (text-only) reveal.
    return Response.json(
      { error: "TTS is not configured (missing ELEVENLABS_API_KEY)." },
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

  const voice = resolveVoice(body.voice);

  let upstream: Response;
  try {
    upstream = await fetch(speechUrl(voice.elevenVoiceId), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
      signal: req.signal,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "TTS upstream request failed." },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // Surface the provider's error text (JSON on failure) without leaking the key.
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: "TTS provider error.", status: upstream.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  // with-timestamps returns JSON: the mp3 (base64) + per-character alignment. Collapse the
  // alignment into word tokens so the client can reveal the line word-by-word as it's pronounced.
  const data = (await upstream.json().catch(() => null)) as ElevenTimestamps | null;
  if (!data?.audio_base64) {
    return Response.json({ error: "TTS provider returned no audio." }, { status: 502 });
  }
  const out: TtsResponse = { audio: data.audio_base64, words: toWords(data.alignment) };
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}

/** ElevenLabs with-timestamps payload (the subset we use). */
interface ElevenTimestamps {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
}

/** Collapse per-character alignment into word tokens (word + trailing whitespace, timed at the
 *  word's first character) so the caption reveals word-by-word in step with the voice. */
function toWords(alignment: ElevenTimestamps["alignment"]): TtsWord[] {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  if (!chars?.length || !starts?.length) return [];
  const words: TtsWord[] = [];
  const space = (c: string) => /\s/.test(c);
  let i = 0;
  while (i < chars.length) {
    while (i < chars.length && space(chars[i])) i++; // skip a whitespace run
    if (i >= chars.length) break;
    const start = starts[i] ?? 0;
    let text = "";
    while (i < chars.length && !space(chars[i])) text += chars[i++]; // the word
    while (i < chars.length && space(chars[i])) text += chars[i++]; // its trailing spaces
    words.push({ text, start });
  }
  return words;
}
