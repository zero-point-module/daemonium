'use client';

/**
 * The conversation between the flame and the control. The container is always present
 * (it holds the flex space that pins the control to the bottom); message bubbles dissolve
 * up into the flame via a top fade mask, and the view sticks to the newest line.
 */
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/app/lib/useFlameDaemon';

export function ChatThread({ messages }: { messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  // Keep the newest line in view: always snap on a NEW message; while Ignis's reply streams
  // into the same bubble (length unchanged, text growing), follow it only if the user is
  // already near the bottom — so someone who scrolled up to read history isn't yanked back.
  const last = messages[messages.length - 1];
  const lastText = last ? last.text : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNew = messages.length > prevLen.current;
    prevLen.current = messages.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNew || nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastText]);

  return (
    <div
      ref={scrollRef}
      className="relative z-[2] flex w-full flex-1 flex-col justify-end gap-[9px] overflow-y-auto px-[22px] pb-1.5 pt-3.5"
      style={{
        minHeight: 0,
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 56px)',
        maskImage: 'linear-gradient(to bottom, transparent 0, #000 56px)',
        scrollbarWidth: 'none',
      }}
    >
      {messages.map((m, i) => {
        const ignis = m.role === 'ignis';
        return (
          <div
            key={i}
            className="flex"
            style={{
              justifyContent: ignis ? 'flex-start' : 'flex-end',
              animation: 'msg-in .35s ease both',
            }}
          >
            <div
              className="text-[15px] leading-[1.42]"
              style={{
                maxWidth: '78%',
                padding: '10px 14px',
                borderRadius: ignis ? '6px 18px 18px 18px' : '18px 18px 6px 18px',
                background: ignis ? 'rgba(255,255,255,.05)' : 'rgba(255,122,24,.16)',
                border: `1px solid ${ignis ? 'rgba(255,255,255,.08)' : 'rgba(255,122,24,.32)'}`,
                color: ignis ? 'rgba(246,236,221,.9)' : '#ffe9d2',
              }}
            >
              {m.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}
