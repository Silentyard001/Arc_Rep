/**
 * server/domain/applications/seed-data.ts
 *
 * Initial seed data for the Arc ecosystem application registry.
 *
 * IMPORTANT DATA INTEGRITY RULES:
 * - Only include applications and contract addresses that are publicly documented
 *   and reliably associated with the Arc ecosystem.
 * - If an application's contract address is uncertain, leave it out rather than
 *   guessing. A wrong address is worse than an absent one.
 * - Mark isVerified: false for any entry that has not been independently confirmed
 *   against official documentation or source verification.
 * - These entries represent Arc Testnet contracts unless noted otherwise.
 * - All addresses are lowercase.
 * - Every contract entry must carry sourceType and sourceRef so an engineer can
 *   answer: "Why do we believe this address belongs to this application?"
 *
 * VERIFICATION STATUS (Phase 4):
 * All entries in this file have been verified against at least one of:
 *   - Official Arc documentation: docs.arc.io/arc/references/contract-addresses
 *   - Arc Studio onchain-facts registry (maintained by Circle engineering)
 *   - Arc Studio built-in agent-standards skill
 *   - Live on-chain read_contract calls confirming contract identity
 *     (e.g. symbol(), name(), or protocol-specific view functions)
 *
 * HOW TO ADD NEW ENTRIES:
 * 1. Establish a defensible source for the contract address.
 * 2. Confirm on-chain that the contract is deployed at that address
 *    (call a view function that identifies it, or check the explorer).
 * 3. Set isVerified: true only when the source is official docs, the
 *    onchain-facts registry, or a live on-chain confirmation.
 * 4. Set sourceType and sourceRef to document the evidence.
 * 5. Do not add placeholder or speculative contract addresses.
 *
 * Addresses in this file are arc-studio-allow-onchain-literal — they are
 * publicly documented Arc ecosystem registry constants, not private keys
 * or wallet addresses, and there is no environment-based alternative
 * for a static known-address registry.
 *
 * Arc Testnet chain ID: 5042002
 * Arc Mainnet chain ID: 5042
 */

// arc-studio-allow-onchain-literal
import type { Application, ApplicationCategory, ApplicationContract } from './types.js';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const SEED_CATEGORIES: ApplicationCategory[] = [
  {
    id: 'defi',
    label: 'DeFi',
    description:
      'Decentralized finance protocols: lending, borrowing, swapping, yield.',
  },
  {
    id: 'bridge',
    label: 'Bridge',
    description:
      'Cross-chain asset transfer and messaging protocols.',
  },
  {
    id: 'payments',
    label: 'Payments',
    description:
      'USDC and stablecoin payment flows, including transfers, payment rails, and escrow.',
  },
  {
    id: 'nft',
    label: 'NFT',
    description: 'Non-fungible token minting, trading, and marketplace contracts.',
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description:
      'Core protocol contracts, token standards, transaction extensions, and chain infrastructure.',
  },
  {
    id: 'gaming',
    label: 'Gaming',
    description: 'Onchain games and entertainment applications.',
  },
  {
    id: 'identity',
    label: 'Identity',
    description:
      'Wallet identity, attestation, reputation, and agent registry contracts.',
  },
  {
    id: 'dao',
    label: 'DAO',
    description: 'Governance and decentralized autonomous organization contracts.',
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Other Arc ecosystem applications.',
  },
];

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export const SEED_APPLICATIONS: Application[] = [
  // -------------------------------------------------------------------------
  // Circle-issued stablecoins
  // -------------------------------------------------------------------------
  {
    id: 'arc-usdc',
    name: 'Arc USDC',
    description:
      'The canonical USDC ERC-20 predeploy on Arc. Native gas token and stablecoin.',
    categoryId: 'infrastructure',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/references/contract-addresses',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'arc-eurc',
    name: 'Arc EURC',
    description:
      'EURC euro-denominated stablecoin issued by Circle, deployed natively on Arc for payments and FX.',
    categoryId: 'infrastructure',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/references/contract-addresses',
    addedAt: '2026-09-23T00:00:00Z',
  },
  {
    id: 'arc-usyc',
    name: 'USYC',
    description:
      'Yield-bearing token issued by Circle International Bermuda Ltd., representing tokenized money market fund shares backed by short-duration U.S. Treasuries. Permissioned (institution-only).',
    categoryId: 'defi',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/references/contract-addresses',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // -------------------------------------------------------------------------
  // Circle crosschain protocols
  // -------------------------------------------------------------------------
  {
    id: 'circle-cctp',
    name: 'Circle CCTP',
    description:
      'Circle Cross-Chain Transfer Protocol — burn-and-mint USDC bridging.',
    categoryId: 'bridge',
    isVerified: true,
    websiteUrl: 'https://developers.circle.com/stablecoins/cctp-getting-started',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'circle-gateway',
    name: 'Circle Gateway',
    description:
      'Circle Gateway — unified USDC balance across chains with instant cross-chain transfers.',
    categoryId: 'bridge',
    isVerified: true,
    websiteUrl: 'https://developers.circle.com/circle-gateway',
    addedAt: '2025-01-01T00:00:00Z',
  },

  // -------------------------------------------------------------------------
  // Circle payments and settlement
  // -------------------------------------------------------------------------
  {
    id: 'circle-stablefx',
    name: 'Circle StableFX',
    description:
      'Enterprise-grade stablecoin FX engine combining Request-for-Quote (RFQ) execution with onchain settlement for stablecoin swaps.',
    categoryId: 'defi',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/references/contract-addresses',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // -------------------------------------------------------------------------
  // Arc transaction extensions (Circle-managed, Arc-specific)
  // -------------------------------------------------------------------------
  {
    id: 'arc-tx-extensions',
    name: 'Arc Transaction Extensions',
    description:
      'Arc-native predeployed contracts for attaching memos to transactions (Memo) and batching multiple calls with preserved msg.sender (Multicall3From). Both use the Arc CallFrom precompile.',
    categoryId: 'infrastructure',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/references/contract-addresses',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // -------------------------------------------------------------------------
  // Arc agent standards (ERC-8004 + ERC-8183)
  // -------------------------------------------------------------------------
  {
    id: 'arc-agent-registry',
    name: 'Arc Agent Registry (ERC-8004)',
    description:
      'ERC-8004 Trustless Agents: onchain agent identity (IdentityRegistry), reputation (ReputationRegistry), and validation (ValidationRegistry) registries. Each agent identity is an ERC-721 token.',
    categoryId: 'identity',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/tutorials/register-your-first-ai-agent',
    addedAt: '2026-09-23T00:00:00Z',
  },
  {
    id: 'arc-agentic-commerce',
    name: 'Arc Agentic Commerce (ERC-8183)',
    description:
      'ERC-8183 escrowed job protocol: a client funds USDC into escrow, a provider agent submits work, and an evaluator releases or refunds the payment. Enables agent-to-agent agentic commerce on Arc.',
    categoryId: 'payments',
    isVerified: true,
    websiteUrl: 'https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job',
    addedAt: '2026-09-23T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Application Contracts
// ---------------------------------------------------------------------------
//
// All addresses are Arc Testnet (chainId 5042002) unless noted.
// USDC predeploy is the same on both mainnet and testnet.
// EURC, CCTP, Gateway, StableFX, extensions, and agent registries
// are testnet-only in this seed.
//
// Verification evidence sources (see sourceType / sourceRef on each entry):
//
//   'onchain-facts'    → src/onchain-facts.ts (FACTS.protocolContracts or chain.usdc)
//                        Maintained by Circle engineering team.
//   'official-docs'    → docs.arc.io/arc/references/contract-addresses
//                        Address from official Arc docs. Some also confirmed on-chain
//                        (see individual sourceRef).
//   'onchain-verified' → Live on-chain call confirmed contract identity this session
//                        (specific function and return value documented in sourceRef).
//
// Do NOT add any address here without a verifiable source citation.
//
// All addresses here are arc-studio-allow-onchain-literal — publicly documented
// Arc ecosystem registry constants with no environment-based alternative.

export const SEED_CONTRACTS: ApplicationContract[] = [

  // =========================================================================
  // Arc USDC — canonical predeploy, same on both mainnet and testnet
  // =========================================================================
  {
    address: '0x3600000000000000000000000000000000000000', // arc-studio-allow-onchain-literal
    applicationId: 'arc-usdc',
    label: 'USDC ERC-20 Predeploy',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getChain(5042002).usdc.address; docs.arc.io/arc/references/contract-addresses §Stablecoins/USDC',
    addedAt: '2025-01-01T00:00:00Z',
  },

  // =========================================================================
  // Arc EURC — testnet
  // on-chain verified: symbol() returns "EURC"
  // =========================================================================
  {
    address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', // arc-studio-allow-onchain-literal
    applicationId: 'arc-eurc',
    label: 'EURC Token (Testnet)',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'docs.arc.io/arc/references/contract-addresses §Stablecoins/EURC; on-chain: symbol()="EURC"',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // =========================================================================
  // USYC — testnet
  // on-chain verified: symbol() returns "USYC"
  // NOTE: Permissioned token. Entitlements + Teller contracts are NOT registered
  //       here — they manage access control, not user-facing application activity.
  //       Only the token contract is registered because token transfers represent
  //       genuine user-facing economic activity.
  // =========================================================================
  {
    address: '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c', // arc-studio-allow-onchain-literal
    applicationId: 'arc-usyc',
    label: 'USYC Token (Testnet)',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'docs.arc.io/arc/references/contract-addresses §Stablecoins/USYC; on-chain: symbol()="USYC"',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // =========================================================================
  // Circle CCTP — Arc Testnet (5 contracts from onchain-facts registry)
  // =========================================================================
  {
    address: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // arc-studio-allow-onchain-literal
    applicationId: 'circle-cctp',
    label: 'CCTP TokenMessengerV2 (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("TokenMessengerV2","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/CCTP',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    address: '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // arc-studio-allow-onchain-literal
    applicationId: 'circle-cctp',
    label: 'CCTP MessageTransmitterV2 (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("MessageTransmitterV2","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/CCTP',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    address: '0xb43db544e2c27092c107639ad201b3defabcf192', // arc-studio-allow-onchain-literal
    applicationId: 'circle-cctp',
    label: 'CCTP TokenMinterV2 (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("TokenMinterV2","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/CCTP',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    address: '0xbac0179bb358a8936169a63408c8481d582390c4', // arc-studio-allow-onchain-literal
    applicationId: 'circle-cctp',
    label: 'CCTP MessageV2 (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("MessageV2","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/CCTP',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    address: '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // arc-studio-allow-onchain-literal
    applicationId: 'circle-cctp',
    label: 'CCTP BridgingKitContract (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("BridgingKitContract","testnet")',
    addedAt: '2025-01-01T00:00:00Z',
  },

  // =========================================================================
  // Circle Gateway — Arc Testnet
  // =========================================================================
  {
    address: '0x0077777d7eba4688bdef3e311b846f25870a19b9', // arc-studio-allow-onchain-literal
    applicationId: 'circle-gateway',
    label: 'Gateway Wallet (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("GatewayWallet","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/Gateway',
    addedAt: '2025-01-01T00:00:00Z',
  },
  {
    address: '0x0022222abe238cc2c7bb1f21003f0a260052475b', // arc-studio-allow-onchain-literal
    applicationId: 'circle-gateway',
    label: 'Gateway Minter (Testnet)',
    isVerified: true,
    sourceType: 'onchain-facts',
    sourceRef: 'onchain-facts.ts: getProtocolContractByName("GatewayMinter","testnet"); docs.arc.io/arc/references/contract-addresses §Crosschain/Gateway',
    addedAt: '2025-01-01T00:00:00Z',
  },

  // =========================================================================
  // Circle StableFX — Arc Testnet
  // Address from official Arc docs. Not an ERC-20/ERC-165 contract so
  // standard view functions (name, symbol, supportsInterface) revert.
  // Contract identity established by official documentation only.
  // =========================================================================
  {
    address: '0xd68256f4d69c6bbecb873d8588ae0dc6b8e22e10', // arc-studio-allow-onchain-literal
    applicationId: 'circle-stablefx',
    label: 'StableFX FxEscrow (Testnet)',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'docs.arc.io/arc/references/contract-addresses §Payments and settlement/StableFX',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // =========================================================================
  // Arc Transaction Extensions — Arc-native predeployed contracts
  // Not ERC-20/ERC-165 contracts; confirmed by official Arc docs only.
  // =========================================================================
  {
    address: '0x5294e9927c3306dcbadb03fe70b92e01ccede505', // arc-studio-allow-onchain-literal
    applicationId: 'arc-tx-extensions',
    label: 'Memo (Arc transaction extension)',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'docs.arc.io/arc/references/contract-addresses §Transaction extensions/Memo',
    addedAt: '2026-09-23T00:00:00Z',
  },
  {
    address: '0x522faf9a91c41c443c66765030741e4aace147d0', // arc-studio-allow-onchain-literal
    applicationId: 'arc-tx-extensions',
    label: 'Multicall3From (Arc transaction extension)',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'docs.arc.io/arc/references/contract-addresses §Transaction extensions/Multicall3From',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // =========================================================================
  // Arc Agent Registry (ERC-8004) — Arc Testnet
  //
  // on-chain verified this session:
  //   IdentityRegistry  (0x8004A...): name()="AgentIdentity"; supportsInterface(0x80ac58cd)=true (ERC-721)
  //   ReputationRegistry(0x8004B...): getClients(1) returned populated address array (live activity)
  //   ValidationRegistry(0x8004C...): getAgentValidations(1) returned [] (valid response, no revert)
  //
  // Also documented in Arc Studio agent-standards built-in skill §Quick Reference.
  // =========================================================================
  {
    address: '0x8004a818bfb912233c491871b3d84c89a494bd9e', // arc-studio-allow-onchain-literal
    applicationId: 'arc-agent-registry',
    label: 'ERC-8004 IdentityRegistry (Testnet)',
    isVerified: true,
    sourceType: 'onchain-verified',
    sourceRef: 'agent-standards SKILL.md §Quick Reference; on-chain: name()="AgentIdentity", supportsInterface(ERC-721)=true',
    addedAt: '2026-09-23T00:00:00Z',
  },
  {
    address: '0x8004b663056a597dffe9eccc1965a193b7388713', // arc-studio-allow-onchain-literal
    applicationId: 'arc-agent-registry',
    label: 'ERC-8004 ReputationRegistry (Testnet)',
    isVerified: true,
    sourceType: 'onchain-verified',
    sourceRef: 'agent-standards SKILL.md §Quick Reference; on-chain: getClients(1) returned populated address array (live activity confirmed)',
    addedAt: '2026-09-23T00:00:00Z',
  },
  {
    address: '0x8004cb1bf31daf7788923b405b754f57aceb4272', // arc-studio-allow-onchain-literal
    applicationId: 'arc-agent-registry',
    label: 'ERC-8004 ValidationRegistry (Testnet)',
    isVerified: true,
    sourceType: 'onchain-verified',
    sourceRef: 'agent-standards SKILL.md §Quick Reference; on-chain: getAgentValidations(1) returned [] (valid response, no revert)',
    addedAt: '2026-09-23T00:00:00Z',
  },

  // =========================================================================
  // Arc Agentic Commerce (ERC-8183) — Arc Testnet
  //
  // on-chain verified this session:
  //   getJob(1) returned a valid Job struct:
  //     client=0xBCF83d..., provider=0x17F6c3..., evaluator=0xBCF83d...,
  //     description="Review a market brief on stablecoin payments in Asia.",
  //     budget=5000000 (5 USDC), status=3 (Completed)
  //   This confirms the contract is live and actively used.
  // =========================================================================
  {
    address: '0x0747eef0706327138c69792bf28cd525089e4583', // arc-studio-allow-onchain-literal
    applicationId: 'arc-agentic-commerce',
    label: 'ERC-8183 AgenticCommerce (Testnet)',
    isVerified: true,
    sourceType: 'onchain-verified',
    sourceRef: 'agent-standards SKILL.md §Quick Reference; on-chain: getJob(1) returned Job{status=3 Completed, budget=5000000, description="Review a market brief on stablecoin payments in Asia."}',
    addedAt: '2026-09-23T00:00:00Z',
  },
];
