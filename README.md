# Master KAI Koinos Node

A developer node workspace for KAI Core Beta, with the complete Master Node dashboard, wallet, block production, Node API and community distribution. This is a separate plugin from Koinos Node; installing it does not replace the regular plugin.

Requires **KAI Core 0.7.3 or later**. Install it from the Plugins marketplace or import its signed `.kaiplugin` release. The installed app appears as **Master KAI Koinos Node** in Core's Apps sidebar.

## The full Master Node workspace

The nine sections are **Dashboard**, **Wallet**, **Fund node**, **Burn KOIN → VHP**, **Node**, **Distribution**, **Node API**, **Reward returns**, and **Node settings**. The layout and features are carried forward from Master Koinos AI Node, including:

- Dashboard synchronization, KOIN/VHP/Mana balances, net worth, blocks produced, rewards, consumed VHP, profit, burns, deposits, node value and return projections.
- A plugin-owned encrypted wallet, funding and swap routes, transaction history, external producer custody and Koin Vault signing.
- Docker setup, logs, automatic recovery, service repair, checked quick sync, backups and reviewed node-profile migration.
- Community distribution with consumed-VHP reburning, configurable profit percentages, AI/producer/combined pools, saved recipients, daily settlement, mana-aware queued payouts and history.
- **Pause distribution** stops tracking and payouts. Mining while paused is skipped on resume. **Reset Stats** clears distribution totals and pending amounts after review and leaves distribution paused; it does not clear wallet balances or the dashboard's lifetime blockchain history.
- A loopback Node API gateway for supported blockchain RPC, already-signed transactions and producer statistics, with optional history/metadata indexes and historical-data checks. Public HTTPS access requires a separately configured tunnel; entering a hostname does not create one.

Distribution and Node API start disabled. Enabling distribution requires the plugin wallet and an explicit action review. Automated payouts require the wallet to remain unlocked. Distribution and Reward returns cannot spend the same rewards at the same time.

### Distribution transaction recovery

The percentage settings divide **profit after replacing consumed VHP**. A 100% profit allocation still reburns consumed VHP first. A cycle appearing in history means the amounts were queued, not that every transaction succeeded.

A failed preparation before submission keeps the queue available for retry. An uncertain result after submission blocks another payment and preserves the queued amounts. Distribution shows the original error, the pending amount, **Copy recovery details**, and a transaction link when its ID is known. Recovery details include only the pending distribution attempt and queue totals, not wallet keys or other feature journals.

Older versions may have saved no transaction ID. Upgrading cannot prove those attempts failed. Before resetting or changing the queue, inspect the original error and the blockchain. On an older installation, open **Node settings**, scroll to **Files live in**, click **open**, then open `state.json` read-only and locate `distribution` → the selected network → your Node wallet address → `inFlight`. Share only that object's error and transaction details when requesting support; do not edit the file or share wallet files.

**Reset Stats** deliberately discards pending amounts and history; it is not a transaction retry or automatic recovery tool. An empty Wallet History alone is not proof that an uncertain transaction was never sent.

## Independent storage and lifecycle

The plugin ID is `kai.master-kai-koinos-node`. Core supplies a separate data directory for its encrypted wallet, settings, chain state and journals. Nothing automatically imports or overwrites a regular Node plugin's or legacy application's wallet, producer keys, chain database or distribution records.

To bring an existing **Master Koinos AI Node** setup over, open **Node settings → Migrate from Master Koinos AI Node**. The review dialog identifies the source, network, destination, producer address, custody mode and available items. Choose chain data, producer/node settings, the existing block-signing key, and an optional encrypted wallet. Existing destination wallets and signing keys are never overwritten. Ordinary Koinos Node and Alpha profiles are not accepted as Master migration sources.

Close the old Master app, including its tray process, before confirming. Migration stops only the verified Master containers. New chain transfers use verified copies, require enough free disk space, and retain the source files; an interrupted transfer started by an older plugin resumes its original move behavior. Progress and pause/resume remain available. Keep the old app closed after the handoff and never run both producers at once.

External custody keeps the same producer address and existing hot block-signing key. The cold account key stays in the external wallet or signing computer; Koin Vault must be connected again when a new externally signed transaction is needed. Migration does not generate or rotate a key, register a key on chain, transfer KOIN/VHP, or replay a pending signing request. The optional encrypted wallet retains its original password and stays locked. If a working local producer uses that wallet, import or otherwise restore the same address rather than creating a replacement.

Mining and automatic startup remain off until reviewed after migration. Automatic spending is disabled when importing profile settings, keys or a wallet. Start sync-only, check the producer address and public signing key, verify the existing on-chain registration, and then deliberately enable production. **Master distribution settings, accounting, pending payouts, funding journals and Node API configuration are not imported by node-profile migration.** Preserve the old profile for those records and resolve any uncertain transaction there before configuring new automation.

Changing pages and closing Core to its tray keep the plugin service active. Disable/remove stops its managed node and drains work. Quitting Core stops the plugin's supervisor, API and scheduled work; already-running Docker containers retain the Node plugin's continuity behavior. Use **Stop node** when you want those containers stopped.

## Trust and architecture

This is a **native plugin with full computer and application access**. The renderer remains sandboxed and communicates through `window.kai.call`; that renderer isolation does not confine the native Node/Electron service. The plugin owns its complete feature implementation and dependencies and uses the same documented Foundation API v1 available to other publishers. No feature engine or private API is added to Core.

Wallet operations retain password checks, styled action review, exact identity checks and cancellation. The public Node API does not expose wallet keys, signing or node administration. Keep publisher private keys outside the repository. A publisher signature establishes identity and package integrity, not a guarantee that native code is harmless.

## Development and publication

```sh
npm ci --ignore-scripts
npm run build
npm test
node scripts/verify-package.js --source
```

Dependencies are locked and bundled by the author. Installation never runs npm or postinstall scripts. The Node API's patched history-service runtime is included and checked against its manifest. Runtime provenance, verification and reproduction instructions are in `scripts/master-block-store-provenance.json`, `scripts/master-block-store-*.js` and `patches/koinos-block-store/`.

Pack `plugin/` using KAI Core's `scripts/core/pack-plugin.js` and the established Ed25519 publisher key. The signed asset is `dist/kai-plugin-master-kai-koinos-node-<version>.kaiplugin`. Large signed assets are committed as bounded parts with exact SHA-256/size metadata; `node scripts/assemble-signed-package.js` restores the original bytes. Assembly cannot create or alter signatures. Run `node scripts/verify-package.js` to verify the signature and exact source/dependency contents before release.

CI tests on Windows, macOS and Linux and publishes only the pre-signed immutable current version after verification. Tests use disposable profiles and synthetic wallet, Docker and RPC fixtures; they do not claim a real node, public tunnel or live financial transaction was exercised.

## Interface language

This plugin follows the language saved in KAI Core Settings and applies changes to open views. English, Spanish, Brazilian Portuguese, French and German are supported through bundled offline catalogs. User content and identifiers stay literal. These source changes require Core 0.7.17+ for the live locale API; release the Core update before publishing a new signed plugin package and catalog entry. See the [public localization API](https://github.com/therexdev/kai-core/blob/main/docs/foundation/PLUGIN_AUTHOR_GUIDE.md#shared-language-and-localization-core-0717).

[Interface language and translation guide](docs/localization.md).
