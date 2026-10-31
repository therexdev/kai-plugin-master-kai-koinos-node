# Master KAI Koinos Node 0.1.1

Fixes the disabled signing-key registration button after importing a wallet or migrating the Master chain. When this plugin's wallet is locked, the button now opens Wallet and explains how to unlock it before reviewing registration of the current node key. Unlocking immediately updates the registration action.

Background refreshes keep registration disabled while approval or submission is pending. Unknown registration status offers a read-only retry; external signing continues through the existing external-wallet flow. Password checks, native approval and transaction identity checks remain required.

Requires KAI Core 0.7.3 or later. Existing chain data, wallet and production keys stay in place. Validation uses synthetic wallets and transactions; no live funds or node registration are changed by tests.
