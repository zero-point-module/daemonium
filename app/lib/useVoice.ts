"use client";

/**
 * Ignis's voice — and the caption that appears *in lockstep with it*, word by word.
 *
 * The agent streams its line token-by-token. We segment it into sentences as they complete and
 * synthesize each the moment it's ready (pipeline: while sentence N plays, N+1… are already being
 * fetched). Each /api/tts call returns the mp3 PLUS per-word timings (ElevenLabs with-timestamps),
 * so while a sentence plays we reveal its words exactly as they're pronounced — driven by the
 * audio clock, not a guess. The caption fills in word-by-word in time with the voice.
 *
 * Pipeline per sentence: POST /api/tts -> { audio (base64 mp3), words } -> decodeAudioData ->
 * AudioBufferSourceNode -> AnalyserNode -> destination. The analyser feeds getAmplitude() for the
 * flame's lip-sync; a rAF loop compares the source's elapsed time to each word's start time and
 * reveals words as they pass — re-rendering only when a new word crosses, not every frame.
 *
 * Graceful degradation: if Web Audio is unavailable, a /api/tts call fails, or alignment is
 * missing, the sentence is still revealed (whole, paced) so the caption never stalls.
 *
 * React-best-practices: caption + isSpeaking are UI state; everything transient (audio nodes, the
 * play queue, segmentation cursor, reveal loop) lives in refs so the flame never re-renders from
 * them. The only effect trigger is the (text, busy) pair; all callbacks are stable.
 *
 * iOS Safari: AudioContext only starts inside a user gesture — call unlock() from a tap
 * (Summon / mic / quick-action / claim) to arm it for the session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";
import type { TtsResponse, TtsWord } from "./voice";

/** Decoded audio + the per-word timings used to reveal this sentence in sync. */
interface Spoken {
  buffer: AudioBuffer | null;
  words: TtsWord[];
}

/** One spoken unit: the sentence, the caption already shown before it, and its prefetched audio. */
interface QueueItem {
  /** This sentence's text — revealed word-by-word as its clip plays. */
  sentence: string;
  /** Caption already on screen before this sentence (prior sentences, trimmed). */
  prefix: string;
  /** The turn this belongs to; a reset bumps the turn token and stale items are dropped. */
  turn: number;
  /** Decoded audio + word timings, or null if synthesis failed / Web Audio is unavailable. */
  audio: Promise<Spoken | null>;
  /** Aborts the in-flight /api/tts fetch on reset/interrupt. */
  controller: AbortController;
}

export interface UseVoice {
  /** The caption to render — revealed word-by-word, synced to playback. */
  caption: string;
  /** True while audio is actively playing (half-duplex hint for the mic). */
  isSpeaking: boolean;
  /** Live voice amplitude 0..1; transient, call per animation frame. 0 when silent. */
  getAmplitude: () => number;
  /** Arm/resume the AudioContext from inside a user gesture (required on iOS Safari). */
  unlock: () => void;
  /** Cut Ignis off NOW: stop playback and drop the queue, and stay silent for the rest of this
   *  turn (the caption freezes at the words reached). Used for tap-to-interrupt / ending. */
  interrupt: () => void;
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

/** Decode a base64 mp3 (delivered alongside its word timings) into bytes for decodeAudioData. */
function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Find sentence-boundary offsets in `s` at or after `from`. A boundary is end-punctuation
 * (.!?…) optionally trailed by a closing quote/bracket, then whitespace — or a newline run.
 * While the model is still streaming (`requireTrailingSpace`), we require real whitespace
 * after the punctuation so we don't cut a sentence that the next token will continue
 * ("12." about to become "12.5"); at turn end we relax that and flush the tail separately.
 */
function sentenceEnds(s: string, from: number, requireTrailingSpace: boolean): number[] {
  const re = requireTrailingSpace
    ? /[.!?…]+["'”’)\]]*\s|\n+/g
    : /[.!?…]+["'”’)\]]*(?:\s|$)|\n+/g;
  re.lastIndex = from;
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    ends.push(re.lastIndex);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return ends;
}

export function useVoice({
  text,
  busy,
  voice,
}: {
  /** The agent's latest line, as it streams (the source we segment + speak). */
  text: string | null;
  /** Whether a turn is in flight. Its true->false edge flushes the final sentence. */
  busy: boolean;
  /** Selected character voice id (app id from lib/voices); sent to /api/tts per sentence. */
  voice?: string;
}): UseVoice {
  const [caption, setCaption] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Audio graph (shared for the page lifetime).
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Scratch buffer reused across amplitude reads to avoid per-frame allocation.
  const ampBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  // The running word-reveal animation frame (one at a time), so we can cancel it on interrupt.
  const revealRafRef = useRef<number | null>(null);

  // Play queue + turn bookkeeping.
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef(false);
  const turnRef = useRef(0);
  // Set by interrupt(): suppresses any remaining speech for the current turn until the next turn
  // begins (the busy rising edge clears it).
  const interruptedRef = useRef(false);
  // resolve() of the play promise currently awaiting a source — called on interrupt so the
  // playLoop unwinds instead of hanging forever (which would pin its AudioBuffer).
  const resolveCurrentRef = useRef<(() => void) | null>(null);

  // Segmentation cursor over the streaming text.
  const cursorRef = useRef(0);
  const prevTextRef = useRef("");
  const prevBusyRef = useRef(busy);

  // Latest selected voice, read inside synthesize so changing it never re-creates callbacks.
  const voiceRef = useRef(voice);
  useEffect(() => {
    voiceRef.current = voice;
  });

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
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const unlock = useCallback(() => {
    ensureContext();
  }, [ensureContext]);

  /** Tear down the current source node + reveal loop (without closing the shared context). */
  const stopSource = useCallback(() => {
    if (revealRafRef.current != null) {
      cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }
    const src = sourceRef.current;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already disconnected */
      }
      sourceRef.current = null;
    }
    // Unblock a play awaiting this source so its playLoop unwinds (and exits on the turn
    // check) instead of hanging forever and pinning the buffer.
    const resolve = resolveCurrentRef.current;
    resolveCurrentRef.current = null;
    resolve?.();
  }, []);

  /** Synthesize one sentence to a decoded buffer + word timings. Null on any failure. */
  const synthesize = useCallback(
    async (sentence: string, signal: AbortSignal): Promise<Spoken | null> => {
      const ctx = ensureContext();
      if (!ctx || !analyserRef.current) return null;
      try {
        const token = getAuthToken();
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text: sentence, voice: voiceRef.current }),
          signal,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as TtsResponse;
        if (signal.aborted) return null;
        const buffer = await ctx.decodeAudioData(base64ToBytes(data.audio));
        return { buffer, words: data.words ?? [] };
      } catch {
        return null; // aborted, network, or decode error — degrade to a paced reveal
      }
    },
    [ensureContext],
  );

  /**
   * Play one sentence's buffer and reveal its words in time with the audio. `sep` is the caption
   * already on screen (prior sentences) plus a separating space; we append revealed words to it.
   * Resolves when the clip ends.
   */
  const playAndReveal = useCallback(
    (buffer: AudioBuffer, words: TtsWord[], sep: string, sentence: string): Promise<void> => {
      return new Promise((resolve) => {
        const ctx = ctxRef.current;
        const analyser = analyserRef.current;
        if (!ctx || !analyser) {
          setCaption(sep + sentence);
          resolve();
          return;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser);
        sourceRef.current = src;
        resolveCurrentRef.current = resolve;

        src.onended = () => {
          if (revealRafRef.current != null) {
            cancelAnimationFrame(revealRafRef.current);
            revealRafRef.current = null;
          }
          if (sourceRef.current === src) sourceRef.current = null;
          if (resolveCurrentRef.current === resolve) resolveCurrentRef.current = null;
          setCaption(sep + sentence); // land on the exact full text at the end
          resolve();
        };

        src.start();

        if (words.length === 0) {
          // No timings — reveal the whole sentence as the clip starts (still voice-synced).
          setCaption(sep + sentence);
        } else {
          // Reveal words as the audio clock passes each one's start time; re-render only when a
          // new word crosses, so this is a handful of updates/sec, not 60.
          const startedAt = ctx.currentTime;
          // Reveal against when the audio is actually HEARD, not when it's processed: outputLatency
          // is tiny on built-in/wired output but ~150-300ms on Bluetooth, where the text would
          // otherwise lead the voice. (Undefined on some Safari builds -> 0, i.e. today's behavior.)
          const outputLatency = ctx.outputLatency || 0;
          let shown = -1;
          const tick = () => {
            if (sourceRef.current !== src) return; // superseded / stopped
            const elapsed = ctx.currentTime - startedAt - outputLatency;
            let count = 0;
            while (count < words.length && words[count].start <= elapsed) count++;
            if (count !== shown) {
              shown = count;
              setCaption(sep + words.slice(0, count).map((w) => w.text).join(""));
            }
            revealRafRef.current = requestAnimationFrame(tick);
          };
          revealRafRef.current = requestAnimationFrame(tick);
        }
      });
    },
    [],
  );

  /** Drain the queue in order, revealing each sentence's words as its audio plays. */
  const playLoop = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    setIsSpeaking(true);
    const myTurn = turnRef.current;
    while (queueRef.current.length) {
      const item = queueRef.current.shift();
      if (!item) break;
      let data: Spoken | null = null;
      try {
        data = await item.audio;
      } catch {
        data = null;
      }
      // A reset (new turn / interrupt) superseded us — exit WITHOUT touching playingRef, which
      // the newer playLoop now owns (a `continue` would race it draining the same queue).
      if (turnRef.current !== myTurn) return;

      const sep = item.prefix ? item.prefix + " " : "";
      if (data?.buffer) {
        await playAndReveal(data.buffer, data.words, sep, item.sentence);
      } else {
        // Silent fallback: reveal the whole sentence, paced so it doesn't flash past.
        setCaption(sep + item.sentence);
        const wait = Math.min(3500, Math.max(650, item.sentence.length * 38));
        await new Promise((r) => setTimeout(r, wait));
      }
      if (turnRef.current !== myTurn) return; // interrupted during playback/wait
    }
    playingRef.current = false;
    setIsSpeaking(false);
  }, [playAndReveal]);

  /** Queue a sentence: start its synthesis immediately (prefetch) and kick the player. `prefix`
   *  is the caption shown for everything before this sentence. */
  const enqueue = useCallback(
    (sentence: string, prefix: string) => {
      const controller = new AbortController();
      const item: QueueItem = {
        sentence,
        prefix,
        turn: turnRef.current,
        audio: synthesize(sentence, controller.signal),
        controller,
      };
      queueRef.current.push(item);
      if (!playingRef.current) void playLoop();
    },
    [synthesize, playLoop],
  );

  /** Clear the stage for a new turn: drop the queue, stop audio, reset the caption + cursor. */
  const reset = useCallback(() => {
    turnRef.current += 1;
    for (const it of queueRef.current) it.controller.abort();
    queueRef.current = [];
    stopSource();
    playingRef.current = false;
    cursorRef.current = 0;
    prevTextRef.current = "";
    setIsSpeaking(false);
    setCaption("");
  }, [stopSource]);

  /** Tap-to-interrupt: silence Ignis at once and stop speaking the rest of this turn. Unlike
   *  reset(), the caption is LEFT as-is (the words reached) and the cursor isn't rewound — we just
   *  stop; interruptedRef keeps the segmentation effect from enqueuing anything more until the
   *  next turn begins. */
  const interrupt = useCallback(() => {
    interruptedRef.current = true;
    turnRef.current += 1; // supersede any in-flight playLoop
    for (const it of queueRef.current) it.controller.abort();
    queueRef.current = [];
    stopSource();
    playingRef.current = false;
    setIsSpeaking(false);
  }, [stopSource]);

  // Segment the streaming text into sentences and feed the voice. The sole trigger is the
  // (text, busy) pair; everything it touches is a ref or a stable callback.
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;

    // A rising busy edge means a fresh turn is starting — wipe the previous line and clear any
    // interrupt latched on the turn that just ended.
    if (busy && !wasBusy) {
      interruptedRef.current = false;
      reset();
    }
    // After an interrupt, stay silent for the rest of this turn (cleared on the next turn above).
    if (interruptedRef.current) return;

    const full = text ?? "";
    // If the text isn't an extension of what we had, realign the cursor (turn boundary).
    if (!full.startsWith(prevTextRef.current)) cursorRef.current = 0;
    prevTextRef.current = full;
    if (!full) return;

    // While streaming we only cut on punctuation followed by whitespace; at turn end we
    // also accept end-of-string and then flush whatever tail remains. Each sentence carries the
    // caption shown BEFORE it (prefix) so playback can append its words to the prior line.
    for (const end of sentenceEnds(full, cursorRef.current, busy)) {
      const startCursor = cursorRef.current;
      const sentence = full.slice(startCursor, end).trim();
      cursorRef.current = end;
      if (sentence) enqueue(sentence, full.slice(0, startCursor).trim());
    }
    if (!busy) {
      const startCursor = cursorRef.current;
      const tail = full.slice(startCursor).trim();
      if (tail) {
        enqueue(tail, full.slice(0, startCursor).trim());
        cursorRef.current = full.length;
      }
    }
  }, [text, busy, enqueue, reset]);

  const getAmplitude = useCallback((): number => {
    const analyser = analyserRef.current;
    const buf = ampBufRef.current;
    if (!analyser || !buf || !sourceRef.current) return 0;
    analyser.getByteTimeDomainData(buf);
    let sumSquares = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / buf.length);
    return Math.min(1, rms * 2.2);
  }, []);

  // Tear down on unmount: abort fetches, stop playback + reveal loop, close the context.
  useEffect(() => {
    return () => {
      for (const it of queueRef.current) it.controller.abort();
      queueRef.current = [];
      stopSource();
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "closed") void ctx.close();
      ctxRef.current = null;
    };
  }, [stopSource]);

  return { caption, isSpeaking, getAmplitude, unlock, interrupt };
}
