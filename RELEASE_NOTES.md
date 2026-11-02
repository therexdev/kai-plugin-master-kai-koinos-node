# Master KAI Koinos Node 0.1.3

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
