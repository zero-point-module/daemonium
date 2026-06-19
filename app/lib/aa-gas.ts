import type { Client, Hex, PublicClient } from "viem";

/**
 * UserOp gas fees that satisfy whatever bundler we're pointed at. Bundlers enforce their own
 * minimum fees, so we ASK the bundler first:
 *   • Pimlico → `pimlico_getUserOperationGasPrice` (returns slow/standard/fast); we use `fast`.
 *   • bundlers without it → fall back to standard EIP-1559 chain estimation.
 * Either way we avoid ZeroDev's proprietary `zd_getUserOperationGasPrice` (ZeroDev-bundler-only),
 * which is the default and breaks on Pimlico/Alchemy.
 */
export async function userOpFees(
  bundlerClient: Client,
  publicClient: PublicClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    const request = bundlerClient.request as (a: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>;
    const gp = (await request({ method: "pimlico_getUserOperationGasPrice", params: [] })) as {
      fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    };
    return {
      maxFeePerGas: BigInt(gp.fast.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(gp.fast.maxPriorityFeePerGas),
    };
  } catch {
    const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
    return { maxFeePerGas, maxPriorityFeePerGas };
  }
}
