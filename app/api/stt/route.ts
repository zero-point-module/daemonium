/**
 * Speech-to-text. The mic hook POSTs the recorded audio blob here as
 * multipart/form-data; we transcribe it server-side and return the text the agent
 * will treat as the user's utterance.
 *
 * Provider note: the Vercel AI Gateway does NOT proxy transcription (its model list
 * has no transcription type), so this route talks to OpenAI's REST API directly
 * (POST /v1/audio/transcriptions) with fetch. The key (OPENAI_API_KEY) stays here on
 * the server and is never sent to the client.
 *
 * iOS Safari note: the blob is usually audio/mp4 (not webm). We don't trust the
 * declared MIME type — we sniff the container from the leading bytes and give OpenAI a
 * filename with the matching extension, so mp4 and webm both transcribe correctly.
 */
import { verifyUser, AuthError } from "@/app/lib/auth";
import { STT_MODEL, type SttResponse } from "@/app/lib/voice";
import { withRoute } from "@/app/lib/observe";
import { createLogger } from "@/app/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Reject anything implausibly large early (OpenAI caps uploads at 25 MB anyway). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Detect the audio container from its magic bytes and return a filename
 * extension + MIME for it. OpenAI keys off the upload's filename extension, so a
 * wrong/missing one gets rejected — we replicate the byte-sniffing the AI SDK used
 * to do. Falls back to the browser-declared type, then to webm (the common case).
 */
function sniffAudio(bytes: Uint8Array, declared: string): { ext: string; mime: string } {
  const ascii = (start: number, str: string) =>
    [...str].every((c, i) => bytes[start + i] === c.charCodeAt(0));

  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return { ext: "webm", mime: "audio/webm" }; // WebM / Matroska (EBML)
  if (ascii(4, "ftyp")) return { ext: "mp4", mime: "audio/mp4" }; // ISO BMFF (mp4/m4a)
  if (ascii(0, "OggS")) return { ext: "ogg", mime: "audio/ogg" };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { ext: "wav", mime: "audio/wav" };
  if (ascii(0, "fLaC")) return { ext: "flac", mime: "audio/flac" };
  if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    return { ext: "mp3", mime: "audio/mpeg" };

  const fromDeclared: Record<string, { ext: string; mime: string }> = {
    "audio/webm": { ext: "webm", mime: "audio/webm" },
    "audio/mp4": { ext: "mp4", mime: "audio/mp4" },
    "audio/m4a": { ext: "m4a", mime: "audio/mp4" },
    "audio/x-m4a": { ext: "m4a", mime: "audio/mp4" },
    "audio/mpeg": { ext: "mp3", mime: "audio/mpeg" },
    "audio/ogg": { ext: "ogg", mime: "audio/ogg" },
    "audio/wav": { ext: "wav", mime: "audio/wav" },
    "audio/x-wav": { ext: "wav", mime: "audio/wav" },
  };
  return fromDeclared[declared.split(";")[0].trim().toLowerCase()] ?? { ext: "webm", mime: "audio/webm" };
}

export const POST = withRoute("stt", postHandler);

async function postHandler(req: Request) {
  // Same security boundary as the other wallet-adjacent routes: only an
  // authenticated user can spend our transcription budget.
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
    // Clear, typed failure so the client can surface it instead of guessing.
    return Response.json(
      { error: "Speech-to-text is unavailable: server missing OPENAI_API_KEY" },
      { status: 500 },
    );
  }

  let audio: ArrayBuffer;
  let declaredType = "";
  try {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json(
        { error: "Expected an `audio` file field (multipart/form-data)" },
        { status: 400 },
      );
    }
    if (file.size === 0) {
      return Response.json({ error: "Empty audio" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: "Audio too large (max 25 MB)" },
        { status: 413 },
      );
    }
    declaredType = file.type;
    audio = await file.arrayBuffer();
  } catch {
    return Response.json(
      { error: "Could not read audio from request" },
      { status: 400 },
    );
  }

  // Container detection from the bytes (iOS sends mp4, Chrome/Android send webm).
  const { ext, mime } = sniffAudio(new Uint8Array(audio, 0, Math.min(audio.byteLength, 16)), declaredType);

  const openaiForm = new FormData();
  openaiForm.append("file", new File([audio], `audio.${ext}`, { type: mime }));
  openaiForm.append("model", STT_MODEL);
  openaiForm.append("response_format", "json");

  try {
    const res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }, // no Content-Type: fetch sets the multipart boundary
      body: openaiForm,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      createLogger("stt").error("transcription failed", { status: res.status, detail });
      return Response.json({ error: "Transcription failed" }, { status: 502 });
    }

    const data = (await res.json()) as { text?: string };
    // Empty text is silence / undecodable audio — not a server fault; let the user retry.
    const body: SttResponse = { text: (data.text ?? "").trim() };
    return Response.json(body);
  } catch (err) {
    createLogger("stt").error("transcription failed", err);
    return Response.json(
      { error: "Transcription failed" },
      { status: 502 },
    );
  }
}
