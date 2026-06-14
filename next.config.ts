import type { NextConfig } from "next";

// Validate the environment at build (and dev/start) — a missing required var fails fast here
// with a clear list, instead of deep inside a request. See app/lib/env.ts.
import "./app/lib/env";

const nextConfig: NextConfig = {
  // The Dynamic server-wallet SDK pulls in native/WASM MPC + attestation modules that
  // must NOT be bundled — leave them as runtime node requires on the server.
  serverExternalPackages: [
    "@dynamic-labs-wallet/node-evm",
    "@dynamic-labs-wallet/node",
    "@dynamic-labs-wallet/core",
    "@dynamic-labs-wallet/primitives",
    "@evervault/wasm-attestation-bindings",
  ],
};

export default nextConfig;
