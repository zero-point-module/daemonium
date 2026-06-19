"use client";

/**
 * Voice picker for Ignis. A compact dark dropdown of the designed character voices (grouped
 * alien / wizard / pirate) plus a one-tap preview so you can audition a voice without running a
 * full agent turn. Selection is owned by the page (persisted to localStorage) and fed to
 * useVoice; preview here is self-contained — it POSTs /api/tts and plays the clip directly,
 * so it doesn't touch the main speech pipeline or its analyser.
 */
import { useCallback, useRef, useState } from "react";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";
import { VOICES, VOICE_CHARACTERS } from "@/app/lib/voices";
import type { TtsResponse } from "@/app/lib/voice";

const SAMPLE = "I am Ignis. Shall we begin?";

export function VoicePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const preview = useCallback(async () => {
    audioRef.current?.pause();
    setPreviewing(true);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: SAMPLE, voice: value }),
      });
      if (!res.ok) throw new Error("preview failed");
      const { audio: b64 } = (await res.json()) as TtsResponse;
      const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
      audioRef.current = audio;
      audio.onended = () => setPreviewing(false);
      await audio.play();
    } catch {
      setPreviewing(false);
    }
  }, [value]);

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 backdrop-blur">
      <select
        aria-label="Ignis voice"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer bg-transparent text-xs text-white/80 outline-none"
      >
        {VOICE_CHARACTERS.map((c) => (
          <optgroup key={c} label={c} className="bg-neutral-900 text-white">
            {VOICES.filter((v) => v.character === c).map((v) => (
              <option key={v.id} value={v.id} className="bg-neutral-900 text-white">
                {v.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onClick={preview}
        aria-label="Preview voice"
        disabled={previewing}
        className="text-[11px] leading-none text-white/55 transition hover:text-white/90 disabled:opacity-40"
      >
        {previewing ? "‹‹" : "▶"}
      </button>
    </div>
  );
}
