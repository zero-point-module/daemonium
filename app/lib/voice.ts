/**
 * Shared voice constants and types (STT + TTS). Safe to import from both the
 * server route (/api/stt) and client code — no secrets, no server-only imports.
 */

/**
 * OpenAI transcription model. gpt-4o-mini-transcribe is the current small STT model:
 * better word-error-rate than whisper-1, accepts mp4/m4a/webm, fast + cheap for the
 * short spoken turns this app sends. Swap to "whisper-1" if you want the most
 * conservative/verbose option, or "gpt-4o-transcribe" for the larger model.
 *
 * NOTE: transcription is NOT available through the Vercel AI Gateway, so /api/stt
 * calls OpenAI directly and requires OPENAI_API_KEY (see .env.example).
 */
export const STT_MODEL = "gpt-4o-mini-transcribe" as const;

/** Response body of POST /api/stt, shared by the route and the mic client. */
export interface SttResponse {
  text: string;
}

/** One spoken word + its clip-relative start time (seconds). */
export interface TtsWord {
  /** Word text INCLUDING any trailing whitespace, so concatenating words rebuilds the line. */
  text: string;
  /** When this word begins, in seconds from the start of THIS clip. */
  start: number;
}

/** Response body of POST /api/tts: the mp3 (base64) + per-word timings for synced reveal. */
export interface TtsResponse {
  /** base64-encoded audio/mpeg. */
  audio: string;
  /** Words in order with clip-relative start times; [] when alignment is unavailable. */
  words: TtsWord[];
}
