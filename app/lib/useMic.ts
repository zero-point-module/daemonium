"use client";

/**
 * Voice capture for Ignis. Tap to record, tap again to stop; on stop we POST the
 * recorded audio to /api/stt and hand the transcript back via onTranscript so the
 * page can feed it to the agent (run/sendPrompt).
 *
 * iOS Safari is the priority and the hardest part:
 *  - getUserMedia + MediaRecorder.start() are armed inside the user's tap (start()).
 *    iOS only grants mic access from a user gesture.
 *  - We do NOT hardcode a mimeType. iOS produces audio/mp4 (it has no webm encoder),
 *    Chrome/Android produce audio/webm. We feature-detect with isTypeSupported and,
 *    if none of our preferred types are supported, let MediaRecorder choose its own
 *    default, then read the real type off the blob. /api/stt sniffs the container
 *    from the bytes, so whatever the device emits works.
 *  - We always stop the mic tracks afterwards so iOS drops the in-use indicator.
 *
 * React best-practices: the transient recording machinery (stream, recorder, chunks)
 * lives in refs so it never causes re-renders; only the small UI-facing flags
 * (recording / transcribing / error) are state. All returned callbacks are stable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";
import type { SttResponse } from "./voice";

/**
 * Preferred recording containers, best-first. iOS supports only the mp4 entries and
 * will fall through to them; Chrome/Android take webm/opus. This is a *preference*,
 * not a requirement — see start() for the fallback when none are supported.
 */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/aac",
] as const;

function pickMimeType(): string | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined; // let MediaRecorder pick its own supported default
}

/** Map a recorder/blob mimeType to a filename extension OpenAI will recognise. */
function extensionFor(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "mp4";
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  return "bin";
}

export interface UseMicOptions {
  /** Called with the final transcript once /api/stt returns. Empty string is skipped. */
  onTranscript: (text: string) => void;
  /**
   * Half-duplex gate: when true, start() is a no-op so we never record while Ignis is
   * speaking. Wire this to the TTS hook's isSpeaking flag.
   */
  isSpeaking?: boolean;
  /** Optional error sink (e.g. denied permission, no mic, network). */
  onError?: (message: string) => void;
}

export interface UseMic {
  /** Mic is open and capturing. */
  recording: boolean;
  /** Audio captured; waiting on /api/stt. */
  transcribing: boolean;
  /** Last error message, or null. */
  error: string | null;
  /** Arm permission + begin recording. MUST be called from a user gesture (tap). */
  start: () => void;
  /** Stop recording; triggers upload + transcription. */
  stop: () => void;
  /** start() if idle, stop() if recording. Call this from the mic button onClick. */
  toggle: () => void;
}

export function useMic({
  onTranscript,
  isSpeaking = false,
  onError,
}: UseMicOptions): UseMic {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Transient capture state — refs so updates never re-render the flame.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startingRef = useRef(false); // guards double-taps during the async start

  // Keep callbacks current without making start/stop depend on them (stable handlers).
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  });

  const fail = useCallback((message: string) => {
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  /** Release the mic stream so iOS clears the "recording" indicator. */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const upload = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    try {
      const token = getAuthToken();
      const ext = extensionFor(blob.type || "audio/mp4");
      const form = new FormData();
      // Filename extension helps the provider identify the container.
      form.append("audio", blob, `speech.${ext}`);

      const res = await fetch("/api/stt", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });

      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(detail?.error ?? `Transcription failed (${res.status})`);
      }

      const { text } = (await res.json()) as SttResponse;
      const clean = text.trim();
      if (clean) onTranscriptRef.current(clean);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setTranscribing(false);
    }
  }, [fail]);

  const start = useCallback(() => {
    if (startingRef.current || recorderRef.current || isSpeaking) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      fail("Recording isn't supported on this browser");
      return;
    }

    startingRef.current = true;
    setError(null);
    chunksRef.current = [];

    // getUserMedia is async but is still inside the tap's task on iOS, which is what
    // the permission/gesture requirement needs.
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        // If stop() was called while we were awaiting permission, bail cleanly.
        if (!startingRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const mimeType = pickMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream); // device default (older iOS / unknown)
        recorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          // Prefer the recorder's negotiated type; fall back to the first chunk's.
          const type =
            recorder.mimeType || chunksRef.current[0]?.type || "audio/mp4";
          const blob = new Blob(chunksRef.current, { type });
          chunksRef.current = [];
          recorderRef.current = null;
          releaseStream();
          setRecording(false);
          if (blob.size > 0) void upload(blob);
        };
        recorder.onerror = () => {
          fail("Recording error");
          releaseStream();
          recorderRef.current = null;
          setRecording(false);
        };

        recorder.start();
        startingRef.current = false;
        setRecording(true);
      })
      .catch((err: unknown) => {
        startingRef.current = false;
        releaseStream();
        const name = err instanceof DOMException ? err.name : "";
        fail(
          name === "NotAllowedError"
            ? "Microphone permission denied"
            : name === "NotFoundError"
              ? "No microphone found"
              : "Could not start recording",
        );
      });
  }, [isSpeaking, fail, releaseStream, upload]);

  const stop = useCallback(() => {
    // Cancel a start still awaiting permission.
    if (startingRef.current) {
      startingRef.current = false;
      releaseStream();
      setRecording(false);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // fires onstop -> upload
    }
  }, [releaseStream]);

  const toggle = useCallback(() => {
    if (recorderRef.current || startingRef.current) stop();
    else start();
  }, [start, stop]);

  // If Ignis starts speaking mid-capture, drop the recording (half-duplex).
  useEffect(() => {
    if (isSpeaking && (recorderRef.current || startingRef.current)) stop();
  }, [isSpeaking, stop]);

  // Clean up the mic on unmount so the track/indicator never leaks.
  useEffect(() => {
    return () => {
      startingRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { recording, transcribing, error, start, stop, toggle };
}
