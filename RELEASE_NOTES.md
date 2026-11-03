# Master KAI Koinos Node 0.1.6

The dashboard reads recent production directly from this computer’s local node, even while the account-history index is rebuilding. A separate **Recent rewards · local chain** panel shows confirmed blocks, minted KOIN, consumed VHP and net profit for the explicitly labeled local window. The activity feed uses those verified receipts and removes overlapping history rows.

The reader checks finality and block continuity, persists a bounded checkpoint, resumes after restart, and reports unavailable or stale data instead of showing a successful empty refresh. New blocks are read before older backfill. Missing old history does not discard already verified recent rewards. Mainnet chain identity, producer identity, receipt identity and token contracts are checked locally.

Lifetime totals remain labeled as indexed history. When history trails locally verified rewards, the dashboard explains the delay and hides incomplete profit projections. Local display amounts never enter distribution or Reward returns journals, so history catching up cannot add these amounts twice or change a paused distribution. This release does not reconcile an earlier uncertain transaction or repair the public account-history index.

Includes English, Spanish, Brazilian Portuguese, French and German labels. Requires KAI Core 0.7.17 or newer. Tests cover synthetic receipts, restart, finality, gaps, missing receipts, branch changes, cancellation, identity changes, cache preservation and feed overlap; no live transactions are submitted.

## Previous releases

# Master KAI Koinos Node 0.1.5

Completes translation coverage for menus, forms, dialogs, tooltips and changing status text in English, Spanish, Brazilian Portuguese, French and German. Open views follow the language saved in Core Settings, including labels created after the view loads. Drafts, names, code and other user content remain intact.

Includes readable offline catalogs, reproducible generation, contributor documentation and regression tests for live language changes. Requires Core 0.7.17 or newer.

Includes the Node API startup fix for large producer caches from 0.1.4.

## Previous release

Master KAI Koinos Node 0.1.4

Fixes Node API startup with a full producer-history cache. The public cache has a bounded 16 MiB allowance, reuses its guarded store when API settings are saved, and no longer creates a backup on every indexing refresh. Settings and financial journals retain their existing protections. Existing cache files and backups are preserved.

An unreadable producer cache is reported separately while blockchain RPC remains available. Startup errors stay visible in endpoint status. The Node API page distinguishes a disabled saved setting from a stopped listener and local RPC readiness, and keeps save errors visible below the button.

Requires KAI Core 0.7.17 or newer. This update retains the shared language setting and distribution safeguards from previous releases. Validation uses disposable profiles and synthetic local RPC services; no live funds are moved.

## Master KAI Koinos Node 0.1.3

Follows the language saved in Core Settings, including changes to open views. Supports English, Spanish, Brazilian Portuguese, French and German with offline catalogs. Core owns the first-run choice; plugin content and identifiers stay literal. Requires Core 0.7.17 or newer.

## Previous release

Master KAI Koinos Node 0.1.2

Distribution no longer permanently blocks a queue when a balance read, mana check, signing step, or other preparation fails before any transaction can be submitted. Queued reburn and payouts remain intact for a later retry. Interrupted preparation is recoverable after restart; errors after the broadcast boundary still block duplicate payments.

Backend `request timeout` responses during known read-only RPC calls now try the configured backup endpoints. This covers balance, mana, nonce and contract-address preparation; a timeout response to a submitted transaction remains uncertain and does not use this read retry path.

The transaction ID, chain ID and nonce are saved before transport. An uncertain result displays the original error and offers **Copy recovery details**, plus a transaction link when available. **Queued reburn** replaces the misleading **Reburned** cycle heading: closing a cycle allocates work and does not prove it was paid.

Existing uncertain records without a transaction ID remain blocked. This update cannot establish whether an older attempt reached the blockchain, and does not automatically clear its accounting. Review the original error and chain evidence before any recovery or deliberate reset. No new recovery transaction, automatic rebroadcast, or automatic on-chain reconciliation is introduced.

Requires KAI Core 0.7.3 or later. The signed update uses the established publisher identity. Tests use disposable profiles and synthetic RPC/signers; they move no live funds.

## Master KAI Koinos Node 0.1.1

Fixes the disabled signing-key registration button after importing a wallet or migrating the Master chain. When this plugin's wallet is locked, the button now opens Wallet and explains how to unlock it before reviewing registration of the current node key. Unlocking immediately updates the registration action.

Background refreshes keep registration disabled while approval or submission is pending. Unknown registration status offers a read-only retry; external signing continues through the existing external-wallet flow. Password checks, native approval and transaction identity checks remain required.

Requires KAI Core 0.7.3 or later. Existing chain data, wallet and production keys stay in place. Validation uses synthetic wallets and transactions; no live funds or node registration are changed by tests.
