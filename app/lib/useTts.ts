"use client";

/**
 * Plays Ignis's spoken lines in the browser and exposes a live amplitude signal so a
 * future mouth can lip-sync to her voice.
 *
 * Pipeline: POST /api/tts -> mp3 bytes -> decodeAudioData -> AudioBufferSourceNode ->
 * AnalyserNode -> destination. The AnalyserNode lets us read the instantaneous loudness.
 *
 * Design (per react-best-practices):
 *  - The amplitude (0..1) is a TRANSIENT, per-frame value, so it is NOT React state — read
 *    it on demand via `getAmplitude()` (cheap, ref-backed). A mouth animation samples it in
 *    a requestAnimationFrame loop without ever re-rendering this hook's consumers.
 *  - `isSpeaking` IS UI/coordination state (the STT side reads it to stay half-duplex and
 *    not capture Ignis's own voice), so it lives in useState.
 *  - All returned callbacks are stable (deps are refs), so consumers don't re-render.
 *
 * iOS Safari: an AudioContext can only start inside a user gesture. Call `unlock()` from a
 * tap handler (Summon / mic / quick-action buttons) to arm audio for the session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";

export interface UseTts {
  /** Speak a line. Interrupts any line currently playing. Resolves when playback ends
   *  (or rejects if synthesis/playback fails). Safe to ignore the promise. */
  speak: (text: string, voice?: string) => Promise<void>;
  /** Stop playback immediately and drop any in-flight request. */
  stop: () => void;
  /** True while audio is actively playing. Half-duplex hint for the STT side. */
  isSpeaking: boolean;
  /** Read the current voice amplitude, 0..1. Transient — call per animation frame.
   *  Returns 0 when nothing is playing. Never triggers a re-render. */
  getAmplitude: () => number;
  /** Arm/resume the AudioContext from inside a user gesture (required on iOS Safari). */
  unlock: () => void;
}

/** Lazily create the shared AudioContext (one per page is plenty). */
function makeContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export function useTts(): UseTts {
  const [isSpeaking, setIsSpeaking] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Scratch buffer reused across amplitude reads to avoid per-frame allocation.
  // Typed as Uint8Array<ArrayBuffer> to match AnalyserNode.getByteTimeDomainData's signature.
  const ampBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  /** Ensure ctx + analyser exist and the ctx is running. Returns null if unsupported. */
  const ensureContext = useCallback((): AudioContext | null => {
    if (!ctxRef.current) {
      const ctx = makeContext();
      if (!ctx) return null;
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      ampBufRef.current = new Uint8Array(analyser.fftSize);
    }
    // resume() is a no-op if already running; on iOS it must be called in a gesture.
    if (ctxRef.current.state === "suspended") {
      void ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const unlock = useCallback(() => {
    ensureContext();
  }, [ensureContext]);

  /** Tear down the current source node (without closing the shared context). */
  const stopSource = useCallback(() => {
    const src = sourceRef.current;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped — ignore
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected — ignore
      }
      sourceRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopSource();
    setIsSpeaking(false);
  }, [stopSource]);

  const speak = useCallback(
    async (text: string, voice?: string): Promise<void> => {
      const line = text.trim();
      if (!line) return;

      // Interrupt anything currently playing or being fetched.
      abortRef.current?.abort();
      stopSource();

      const ctx = ensureContext();
      if (!ctx || !analyserRef.current) {
        // No Web Audio support — caller falls back to silent captions.
        throw new Error("AudioContext unavailable");
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const token = getAuthToken();
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: line, voice }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail && (detail.error as string)) ?? `TTS failed (${res.status})`,
        );
      }

      const encoded = await res.arrayBuffer();
      // If a newer call superseded us while bytes were in flight, bail quietly.
      if (controller.signal.aborted) return;

      const audioBuffer = await ctx.decodeAudioData(encoded);
      if (controller.signal.aborted) return;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyserRef.current);
      sourceRef.current = source;

      return new Promise<void>((resolve) => {
        source.onended = () => {
          if (sourceRef.current === source) {
            sourceRef.current = null;
            setIsSpeaking(false);
          }
          resolve();
        };
        setIsSpeaking(true);
        source.start();
      });
    },
    [ensureContext, stopSource],
  );

  const getAmplitude = useCallback((): number => {
    const analyser = analyserRef.current;
    const buf = ampBufRef.current;
    if (!analyser || !buf || !sourceRef.current) return 0;
    analyser.getByteTimeDomainData(buf);
    // RMS of the waveform around the 128 midpoint, normalised to ~0..1.
    let sumSquares = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / buf.length);
    return Math.min(1, rms * 2.2);
  }, []);

  // Clean up on unmount: stop playback and close the shared context.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopSource();
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "closed") {
        void ctx.close();
      }
      ctxRef.current = null;
    };
  }, [stopSource]);

  return { speak, stop, isSpeaking, getAmplitude, unlock };
}
