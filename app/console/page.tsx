'use client';

import { DynamicWidget, useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { useAccount } from 'wagmi';
import { explorerAddress } from '../lib/chain';
import { Console } from '../components/console';
import { HandleGate } from '../components/handle-gate';

/**
 * Dev panel — Dynamic login, embedded-wallet info, and the agent test console.
 * Kept on its own route so the flame at `/` stays clean; this is where you sign
 * in and drive the real backend directly.
 */
export default function DevConsolePage() {
  const { user, primaryWallet } = useDynamicContext();
  const { address, chainId, isConnected } = useAccount();

  return (
    <div className="flex min-h-[100dvh] flex-col items-center bg-black font-sans text-zinc-100">
      <main className="flex w-full max-w-xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-orange-400">
            Daemonium · dev console
          </h1>
          <DynamicWidget />
        </header>

        {!user ? (
          <p className="text-sm text-zinc-400">
            Sign in above to summon Ignis. Login provisions your embedded wallet
            — one MPC address across Ethereum mainnet and Base.
          </p>
        ) : (
          <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm">
            <Row label="User" value={user.email ?? user.userId ?? '—'} />
            <Row
              label="Embedded wallet"
              value={primaryWallet?.address ?? '—'}
              href={
                primaryWallet?.address
                  ? explorerAddress(primaryWallet.address)
                  : undefined
              }
            />
            <Row
              label="wagmi useAccount"
              value={
                isConnected
                  ? `${address ?? '—'} (chain ${chainId ?? '?'})`
                  : 'not connected'
              }
            />
          </section>
        )}

        {user && (
          <HandleGate>
            {(ensName) => (
              <>
                <p className="text-xs text-zinc-500">
                  dæmon: <span className="font-mono text-orange-300">{ensName}</span>
                </p>
                <Console />
              </>
            )}
          </HandleGate>
        )}
      </main>
    </div>
  );
}

function Row({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-mono text-orange-300 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="break-all font-mono text-zinc-200">{value}</span>
      )}
    </div>
  );
}
