/**
 * Speech-to-text. The mic hook POSTs the recorded audio blob here as
 * multipart/form-data; we transcribe it server-side and return the text the agent
 * will treat as the user's utterance.
 *
 * Provider note: the Vercel AI Gateway does NOT proxy transcription (its model list
 * has no transcription type), so this route talks to OpenAI directly via the AI SDK's
 * experimental_transcribe + @ai-sdk/openai. The key (OPENAI_API_KEY) stays here on the
 * server and is never sent to the client.
 *
 * iOS Safari note: the blob is usually audio/mp4 (not webm). We do NOT hardcode a type
 * — the AI SDK detects the media type from the audio bytes, so mp4 and webm both work.
 */
import {
  experimental_transcribe as transcribe,
  NoTranscriptGeneratedError,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { STT_MODEL, type SttResponse } from "@/app/lib/voice";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Reject anything implausibly large early (OpenAI caps uploads at 25 MB anyway). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
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
    audio = await file.arrayBuffer();
  } catch {
    return Response.json(
      { error: "Could not read audio from request" },
      { status: 400 },
    );
  }

  const openai = createOpenAI({ apiKey });

  try {
    const { text } = await transcribe({
      model: openai.transcription(STT_MODEL),
      // Uint8Array of the recorded bytes; the SDK sniffs the container
      // (audio/mp4 on iOS, audio/webm on Chrome/Android) from the bytes.
      audio: new Uint8Array(audio),
    });

    const body: SttResponse = { text: text.trim() };
    return Response.json(body);
  } catch (err) {
    if (NoTranscriptGeneratedError.isInstance(err)) {
      // Silence or undecodable audio — not a server fault; let the user retry.
      const body: SttResponse = { text: "" };
      return Response.json(body);
    }
    console.error("stt transcription failed", err);
    return Response.json(
      { error: "Transcription failed" },
      { status: 502 },
    );
  }
}
