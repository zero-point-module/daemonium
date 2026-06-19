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

/**
 * VAD (voice-activity detection) tuning for hands-free endpointing. These are deliberate but
 * conservative defaults — they WILL need calibration on a real device + mic: the RMS threshold
 * in particular depends on mic gain and the browser's noise suppression.
 */
const VAD_SAMPLE_MS = 50; // how often we measure the input level
const VAD_RMS_THRESHOLD = 0.025; // above this = "voice", below = "silence"
const VAD_ONSET_TICKS = 2; // consecutive voiced samples before it counts as speech (filters clicks)
const VAD_MIN_SPEECH_MS = 250; // a turn needs at least this much real voice — filters coughs/bumps
const VAD_HANGOVER_MS = 800; // trailing silence after speech that ends the turn
const VAD_NO_SPEECH_MS = 10000; // mic opened but heard nothing at all -> give up (onNoSpeech)
const VAD_MAX_MS = 20000; // hard cap on a single utterance

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
  /**
   * Hands-free endpointing: when true, an open mic auto-stops on end-of-speech (and uploads), so
   * the user never taps to stop. Default false = manual tap-to-stop.
   */
  auto?: boolean;
  /**
   * Called when an auto (VAD) capture opened but heard no speech within VAD_NO_SPEECH_MS — the
   * recording is discarded (not uploaded). The page uses this to end a hands-free conversation
   * that's gone quiet instead of holding the mic open forever.
   */
  onNoSpeech?: () => void;
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
  /** Stop recording and DISCARD it (no upload) — e.g. the user ended the conversation. */
  cancel: () => void;
}

export function useMic({
  onTranscript,
  isSpeaking = false,
  onError,
  auto = false,
  onNoSpeech,
}: UseMicOptions): UseMic {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Transient capture state — refs so updates never re-render the flame.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startingRef = useRef(false); // guards double-taps during the async start
  const discardNextRef = useRef(false); // tear down the next stop() WITHOUT uploading

  // VAD graph + loop — only used when `auto` is set. Refs so the measuring loop never re-renders.
  const vadCtxRef = useRef<AudioContext | null>(null);
  const vadAnalyserRef = useRef<AnalyserNode | null>(null);
  const vadBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep callbacks current without making start/stop depend on them (stable handlers).
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onNoSpeechRef = useRef(onNoSpeech);
  const autoRef = useRef(auto);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    onNoSpeechRef.current = onNoSpeech;
    autoRef.current = auto;
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

  /** Lazily create + resume the analysis AudioContext. Called synchronously inside the starting
   *  tap so iOS unlocks it from the gesture; reused across captures afterwards. */
  const ensureVadContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!vadCtxRef.current) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      vadCtxRef.current = ctx;
      vadAnalyserRef.current = analyser;
      vadBufRef.current = new Uint8Array(analyser.fftSize);
    }
    if (vadCtxRef.current.state === "suspended") void vadCtxRef.current.resume();
    return vadCtxRef.current;
  }, []);

  /** Stop the VAD loop and detach the per-capture source (keeps the context alive for reuse). */
  const stopVad = useCallback(() => {
    if (vadTimerRef.current != null) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (vadSourceRef.current) {
      try {
        vadSourceRef.current.disconnect();
      } catch {
        /* already disconnected */
      }
      vadSourceRef.current = null;
    }
  }, []);

  /** Measure the input level and auto-stop on end-of-speech (hands-free). Falls back to manual
   *  tap-to-stop if Web Audio is unavailable. Operates on recorderRef directly so it never has to
   *  depend on the stop() callback. */
  const beginVad = useCallback(
    (stream: MediaStream) => {
      const ctx = ensureVadContext();
      const analyser = vadAnalyserRef.current;
      const buf = vadBufRef.current;
      if (!ctx || !analyser || !buf) return;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser); // analysis only — deliberately NOT connected to destination
      vadSourceRef.current = source;

      const startedAt = Date.now();
      let lastVoiceAt = startedAt;
      let voicedTicks = 0;
      let voicedMs = 0; // cumulative voiced time this utterance — gates real speech vs a blip
      let speechStarted = false;

      vadTimerRef.current = setInterval(() => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") return;
        analyser.getByteTimeDomainData(buf);
        let sumSquares = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buf.length);
        const now = Date.now();

        if (rms > VAD_RMS_THRESHOLD) {
          voicedTicks++;
          voicedMs += VAD_SAMPLE_MS;
          lastVoiceAt = now;
          if (!speechStarted && voicedTicks >= VAD_ONSET_TICKS) speechStarted = true;
        } else {
          voicedTicks = 0;
        }

        if (!speechStarted) {
          // Heard nothing yet — give up after a while so the mic never stays open forever.
          if (now - startedAt > VAD_NO_SPEECH_MS) {
            discardNextRef.current = true;
            onNoSpeechRef.current?.();
            recorder.stop(); // onstop discards (see discardNextRef)
          }
          return;
        }
        if (now - lastVoiceAt > VAD_HANGOVER_MS) {
          if (voicedMs >= VAD_MIN_SPEECH_MS) {
            recorder.stop(); // real speech + trailing silence -> end the turn (onstop uploads)
          } else {
            // Too little real voice to be a turn (a cough/bump) — keep listening, don't upload.
            speechStarted = false;
            voicedMs = 0;
          }
          return;
        }
        if (now - startedAt > VAD_MAX_MS) recorder.stop(); // hard cap -> upload what we have
      }, VAD_SAMPLE_MS);
    },
    [ensureVadContext],
  );

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

    // Unlock the analysis context from inside this tap (iOS) so hands-free endpointing can
    // measure the input level. Harmless when `auto` is off.
    if (autoRef.current) ensureVadContext();

    // getUserMedia is async but is still inside the tap's task on iOS, which is what
    // the permission/gesture requirement needs.
    navigator.mediaDevices
      // Ask for the browser's voice processing: echo cancellation keeps the reopened mic from
      // hearing Ignis's own tail (half-duplex barge-in), and noise suppression steadies the noise
      // floor so the fixed VAD threshold behaves more consistently across devices.
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
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
          stopVad();
          const discard = discardNextRef.current;
          discardNextRef.current = false;
          // Prefer the recorder's negotiated type; fall back to the first chunk's.
          const type =
            recorder.mimeType || chunksRef.current[0]?.type || "audio/mp4";
          const blob = new Blob(chunksRef.current, { type });
          chunksRef.current = [];
          recorderRef.current = null;
          releaseStream();
          setRecording(false);
          // `discard` = throw this capture away instead of transcribing it: Ignis began
          // speaking, the user ended the conversation, or VAD heard no speech at all.
          if (!discard && blob.size > 0) void upload(blob);
        };
        recorder.onerror = () => {
          stopVad();
          fail("Recording error");
          releaseStream();
          recorderRef.current = null;
          setRecording(false);
        };

        recorder.start();
        startingRef.current = false;
        setRecording(true);
        if (autoRef.current) beginVad(stream);
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
  }, [isSpeaking, fail, releaseStream, upload, ensureVadContext, beginVad, stopVad]);

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

  /** Stop and DISCARD the current capture (no upload) — used when ending a conversation. */
  const cancel = useCallback(() => {
    if (startingRef.current) {
      startingRef.current = false;
      releaseStream();
      setRecording(false);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      discardNextRef.current = true;
      recorder.stop(); // onstop discards
    }
  }, [releaseStream]);

  // If Ignis starts speaking mid-capture, drop the recording (half-duplex) WITHOUT uploading
  // the partial audio. Only flag discard when a real recorder exists; a still-arming start has
  // captured nothing, and stop() there just cancels the pending getUserMedia.
  useEffect(() => {
    if (!isSpeaking) return;
    if (recorderRef.current) {
      discardNextRef.current = true;
      stop();
    } else if (startingRef.current) {
      stop();
    }
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
      // Tear down the VAD loop, source, and context.
      if (vadTimerRef.current != null) clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
      vadSourceRef.current?.disconnect();
      vadSourceRef.current = null;
      const vadCtx = vadCtxRef.current;
      if (vadCtx && vadCtx.state !== "closed") void vadCtx.close();
      vadCtxRef.current = null;
    };
  }, []);

  return { recording, transcribing, error, start, stop, toggle, cancel };
}
