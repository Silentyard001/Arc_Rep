/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
// arc.rpcUrls.default.http may be empty in some viem versions; fall back to the
// public Arc Mainnet RPC endpoint so tracing still labels chain 5042 correctly.
const ARC_MAINNET_RPC: string = (arc.rpcUrls.default.http as readonly string[])[0] ?? 'https://rpc.mainnet.arc.io'
registerChain(arc.id, ARC_MAINNET_RPC)

export const config = createConfig({
  chains: [arc, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arc.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
