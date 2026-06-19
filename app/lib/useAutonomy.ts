"use client";

/**
 * Opt-in AUTONOMY for the user's dæmon. Fetches the current grant status, and lets the user grant
 * or revoke a scoped session key with their embedded wallet. Granting builds + signs a ZeroDev
 * permission account client-side (createSessionApproval) and posts the serialized approval to
 * /api/daemon/grant; revoking flips it off. While a grant is active, value actions within its
 * on-chain limits run without a per-action signature (the server signs with the agent's key).
 */
import { useCallback, useEffect, useState } from "react";
import { useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { parseEther, type Address } from "viem";
import { authHeaders } from "./daemon-client";
import { createSessionApproval, type ConnectedWalletClient } from "./smart-account-client";
import { VALUE_POLICY_TARGETS } from "./chain";

export interface AutonomyState {
  active: boolean;
  agentKey: string | null;
  sessionSignerAddress: string | null;
  busy: boolean;
  error: string | null;
  policy?: { maxUsdc?: number; validUntil?: number };
  grant: (opts?: { maxUsdc?: number; days?: number }) => Promise<void>;
  revoke: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAutonomy(): AutonomyState {
  const { data: walletClient } = useWalletClient();
  const [active, setActive] = useState(false);
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [sessionSignerAddress, setSigner] = useState<string | null>(null);
  const [policy, setPolicy] = useState<{ maxUsdc?: number; validUntil?: number } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/daemon/grant", { headers: authHeaders() }).then((x) => x.json());
      if (r && !r.error) {
        setActive(Boolean(r.active));
        setAgentKey(r.agentKey ?? null);
        setSigner(r.sessionSignerAddress ?? null);
        setPolicy(r.policy);
      }
    } catch {
      /* status fetch is best-effort */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grant = useCallback(
    async (opts?: { maxUsdc?: number; days?: number }) => {
      if (!walletClient) {
        setError("Connect your wallet first.");
        return;
      }
      if (!sessionSignerAddress) {
        setError("No session signer yet — finish setup first.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const targets = Object.values(VALUE_POLICY_TARGETS) as Address[];
        const validUntil = Math.floor(Date.now() / 1000) + (opts?.days ?? 7) * 86_400;
        const approvalBlob = await createSessionApproval({
          walletClient: walletClient as ConnectedWalletClient,
          chainId: base.id,
          sessionSignerAddress: sessionSignerAddress as Address,
          policy: {
            targets,
            maxNativeWei: parseEther("0.01"),
            gasAllowanceWei: parseEther("0.02"),
            validUntil,
          },
        });
        await fetch("/api/daemon/grant", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            approvalBlob,
            chainId: base.id,
            policy: { maxUsdc: opts?.maxUsdc, targets, validUntil },
          }),
        });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [walletClient, sessionSignerAddress, refresh],
  );

  const revoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/daemon/grant", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ revoke: true }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { active, agentKey, sessionSignerAddress, busy, error, policy, grant, revoke, refresh };
}
