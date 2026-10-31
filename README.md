# Master KAI Koinos Node

A developer node workspace for KAI Core Beta, with the complete Master Node dashboard, wallet, block production, Node API and community distribution. This is a separate plugin from Koinos Node; installing it does not replace the regular plugin.

Requires **KAI Core 0.7.3 or later**. Install it from the Plugins marketplace or import its signed `.kaiplugin` release. The installed app appears as **Master KAI Koinos Node** in Core's Apps sidebar.

## The full Master Node workspace

The nine sections are **Dashboard**, **Wallet**, **Fund node**, **Burn KOIN → VHP**, **Node**, **Distribution**, **Node API**, **Reward returns**, and **Node settings**. The layout and features are carried forward from Master Koinos AI Node, including:

- Dashboard synchronization, KOIN/VHP/Mana balances, net worth, blocks produced, rewards, consumed VHP, profit, burns, deposits, node value and return projections.
- A plugin-owned encrypted wallet, funding and swap routes, transaction history, external producer custody and Koin Vault signing.
- Docker setup, logs, automatic recovery, service repair, checked quick sync, backups and explicit chain-data migration.
- Community distribution with consumed-VHP reburning, configurable profit percentages, AI/producer/combined pools, saved recipients, daily settlement, mana-aware queued payouts and history.
- **Pause distribution** stops tracking and payouts. Mining while paused is skipped on resume. **Reset Stats** clears distribution totals and pending amounts after review and leaves distribution paused; it does not clear wallet balances or the dashboard's lifetime blockchain history.
- A loopback Node API gateway for supported blockchain RPC, already-signed transactions and producer statistics, with optional history/metadata indexes and historical-data checks. Public HTTPS access requires a separately configured tunnel; entering a hostname does not create one.

Distribution and Node API start disabled. Enabling distribution requires the plugin wallet and an explicit action review. Automated payouts require the wallet to remain unlocked. Distribution and Reward returns cannot spend the same rewards at the same time.

## Independent storage and lifecycle

The plugin ID is `kai.master-kai-koinos-node`. Core supplies a separate data directory for its encrypted wallet, settings, chain state and journals. Nothing automatically imports or overwrites a regular Node plugin's or legacy application's wallet, producer keys, chain database or distribution records.

Import a wallet deliberately if you want to use an existing address. Chain migration requires a reviewed source and explicit confirmation; it does not transfer wallets, private production keys, KOIN or VHP. Do not start a second node against the same data or ports. Existing node ownership checks prevent silently taking over another profile's stack.

To bring an existing **Master Koinos AI Node** chain over, open **Node settings → Migrate from Master Koinos AI Node**. Close the old Master app, including its tray process, review the detected source/network and destination, then confirm. Migration stops only the verified Master containers and transfers the chain with progress and pause/resume support. Files on the same drive can move without keeping another full copy; cross-drive transfers verify each copy before removing its source. Ordinary Koinos Node profiles are not accepted as Master migration sources. Mining remains off after migration.

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
