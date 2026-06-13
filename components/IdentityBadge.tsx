'use client';

import { useEffect, useState } from 'react';
import { useDynamicContext, getAuthToken } from '@dynamic-labs/sdk-react-core';

/**
 * The dæmon's identity chip. Once the user is signed in we read their real ENS name
 * (ignis.<handle>.daemonium.eth) from /api/daemon/handle; before that we show the
 * parent brand as a teaser. We never show a fabricated per-user id.
 */
export function IdentityBadge() {
  const { user } = useDynamicContext();
  const [ensName, setEnsName] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setEnsName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch('/api/daemon/handle', {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setEnsName(data.ensName ?? null);
      } catch {
        // keep the teaser on any failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 backdrop-blur-sm">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 8px var(--state, #ff7a18)',
        }}
      />
      <span className="text-[13px] font-medium tracking-wide">
        {ensName ?? 'ignis.daemonium.eth'}
      </span>
    </div>
  );
}
