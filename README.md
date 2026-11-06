# Master KAI Koinos Node

A developer node workspace for KAI Core Beta, with the complete Master Node dashboard, wallet, block production, Node API and community distribution. This is a separate plugin from Koinos Node; installing it does not replace the regular plugin.

Requires **KAI Core 0.7.3 or later**. Install it from the Plugins marketplace or import its signed `.kaiplugin` release. The installed app appears as **Master KAI Koinos Node** in Core's Apps sidebar.

## The full Master Node workspace

The nine sections are **Dashboard**, **Wallet**, **Fund node**, **Burn KOIN → VHP**, **Node**, **Distribution**, **Node API**, **Reward returns**, and **Node settings**. The layout and features are carried forward from Master Koinos AI Node, including:

- Dashboard synchronization, KOIN/VHP/Mana balances, net worth, blocks produced, rewards, consumed VHP, profit, burns, deposits, node value and return projections.
- An Airdrops tab for equal KOIN/VHP splits or comma/tab-separated per-wallet amounts, with reviewed recipient lists, resumable payment journals and CSV reports.
- A plugin-owned encrypted wallet, funding and swap routes, transaction history, external producer custody and Koin Vault signing.
- Docker setup, logs, automatic recovery, service repair, checked quick sync, backups and explicit chain-data migration.
- Community distribution with consumed-VHP reburning, configurable profit percentages, AI/producer/combined pools, saved recipients, daily settlement, mana-aware queued payouts and history.
- **Pause distribution** stops tracking and payouts. Mining while paused is skipped on resume. **Reset Stats** clears distribution totals and pending amounts after review and leaves distribution paused; it does not clear wallet balances or the dashboard's lifetime blockchain history.
- A loopback Node API gateway for supported blockchain RPC, already-signed transactions and producer statistics, with optional history/metadata indexes and historical-data checks. Public HTTPS access requires a separately configured tunnel; entering a hostname does not create one.

Distribution and Node API start disabled. Enabling distribution requires the plugin wallet and an explicit action review. Automated payouts require the wallet to remain unlocked. Distribution and Reward returns cannot spend the same rewards at the same time.

### Recent local rewards

The Dashboard’s **Recent rewards · local chain** panel reads finalized blocks and receipts from this computer’s node directly. It works independently of the public Node API and account-history index. The panel labels the block range and starting time; these are bounded recent-window figures, not lifetime totals. New blocks are read first, then older blocks are loaded in small batches. A separate cache resumes after restart and is checked against the canonical chain before reuse.

The activity feed replaces overlapping indexed block rows with locally verified rewards. Indexed lifetime totals remain separate, with a warning when they trail local production; incomplete profit projections are withheld. An unavailable local node is shown explicitly, and previously verified rows are marked stale. This dashboard cache never changes distribution or Reward returns balances, baselines or journals. Pausing distribution keeps its existing behavior.

### Distribution transaction recovery

The percentage settings divide **profit after replacing consumed VHP**. A 100% profit allocation still reburns consumed VHP first. A cycle appearing in history means the amounts were queued, not that every transaction succeeded.

A failed preparation before submission keeps the queue available for retry. An uncertain result after submission blocks another payment and preserves the queued amounts. Distribution shows the original error, the pending amount, **Copy recovery details**, and a transaction link when its ID is known. Recovery details include only the pending distribution attempt and queue totals, not wallet keys or other feature journals.

Older versions may have saved no transaction ID. Upgrading cannot prove those attempts failed. Before resetting or changing the queue, inspect the original error and the blockchain. On an older installation, open **Node settings**, scroll to **Files live in**, click **open**, then open `state.json` read-only and locate `distribution` → the selected network → your Node wallet address → `inFlight`. Share only that object's error and transaction details when requesting support; do not edit the file or share wallet files.

**Reset Stats** deliberately discards pending amounts and history; it is not a transaction retry or automatic recovery tool. An empty Wallet History alone is not proof that an uncertain transaction was never sent.

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

## Interface language

This plugin follows the language saved in KAI Core Settings and applies changes to open views. English, Spanish, Brazilian Portuguese, French and German are supported through bundled offline catalogs. User content and identifiers stay literal. These source changes require Core 0.7.17+ for the live locale API; release the Core update before publishing a new signed plugin package and catalog entry. See the [public localization API](https://github.com/therexdev/kai-core/blob/main/docs/foundation/PLUGIN_AUTHOR_GUIDE.md#shared-language-and-localization-core-0717).

[Interface language and translation guide](docs/localization.md).


## Airdrops (0.1.7)

1. Open **Airdrops** and choose **KOIN** or **VHP**. Funds come from this plugin's Node wallet on the selected network, not the Core wallet or an external producer wallet.
2. Choose **Split a total equally** and enter the total plus a list of addresses; or choose **Amount for each wallet** and paste `ADDRESS,AMOUNT` rows or two tab-separated spreadsheet columns. `ADDRESS,TOKEN-AMOUNT` is an optional header. Amounts use a decimal point, up to eight decimal places, and no thousands separators. Limit: 2,000 unique recipients per campaign.
3. Click **Preview airdrop**, inspect every recipient and the total, then **Save reviewed list**. Equal splits allocate remaining atomic units (0.00000001) to the first addresses in list order. Duplicates, self-payments, invalid checksums, zero/negative amounts and excessive precision are rejected. An untouched draft can be discarded and recreated.
4. Pause community distribution and disable reward returns. Keep enough liquid KOIN and mana; VHP transfers also need mana and reduce the sending wallet's mining power.
5. Click **Start / resume airdrop**, prove the Node wallet password and approve the native review. Keep the app running. **Pause airdrop** finishes the current transaction and stops before the next. Reopening the app never automatically resumes sending.
6. Use **Export payment record CSV** for the KAI/KOIN drop record. Reports include the network, sender, token, every recipient and exact amount, payment status, transaction ID and prior attempt IDs. Completed campaigns remain in Previous airdrops (up to 20 archived campaigns).

The native journal records each transaction identity before broadcast. A timeout or lost response stops the campaign; an uncertain payment is never automatically resent. **Check uncertain transaction** requires an exact transaction on the original chain with a canonical irreversible receipt. A verified successful payment is marked sent; a verified reverted payment can be retried after a fresh start/resume approval. Missing or unindexed transactions remain blocked. If the RPC does not expose transaction/block history, restore an endpoint with that history before checking again; do not delete the journal to bypass recovery. `sent` means observed included (or reconciled irreversible), not that every normal payment has already reached finality.

This release uses the established publisher signature and automated synthetic transaction/native-boundary tests. No live funds were sent. Install the verified 0.1.7 package after the release workflow completes.
