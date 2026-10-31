"use strict";
const { Serializer, Transaction, utils } = require("koilib");
const { isDeepStrictEqual } = require("node:util");
const native = new Serializer(utils.tokenAbi.types);
// A balance read consumes the reviewed owner nonce when included as a signed
// transaction, but cannot transfer KOIN, approve spending, or buy credits.
function operation(deployment, owner) {
  if (!utils.isChecksumAddress(owner) || !utils.isChecksumAddress(deployment.token)) throw Error("Pinned cancellation owner and token required");
  const method = utils.tokenAbi.methods.balanceOf;
  const bytes = native.root.lookupType(method.argument).encode({ owner: utils.decodeBase58(owner) }).finish();
  return { call_contract: { contract_id: deployment.token, entry_point: method.entry_point, args: utils.encodeBase64url(bytes) } };
}
function matches(deployment, original, draft) {
  try {
    if (!original?.header || original.header.payee !== undefined || !draft?.header || draft.header.payee !== undefined ||
        original.header.chain_id !== deployment.chainId || draft.id === original.id || draft.signatures?.length ||
        !isDeepStrictEqual(draft.operations, [operation(deployment, original.header.payer)])) return false;
    const header = { ...draft.header, operation_merkle_root: original.header.operation_merkle_root };
    return isDeepStrictEqual(header, original.header);
  } catch { return false; }
}
async function prepare(deployment, original) {
  const draft = await Transaction.prepareTransaction({ header: { ...original.header },
    operations: [operation(deployment, original.header.payer)], signatures: [] });
  if (!matches(deployment, original, draft)) throw Error("Exact same-nonce zero-transfer cancellation required");
  return draft;
}
module.exports = { operation, matches, prepare };
