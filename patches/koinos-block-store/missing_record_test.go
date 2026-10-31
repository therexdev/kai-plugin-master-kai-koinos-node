package bstore

import (
	"bytes"
	"errors"
	"fmt"
	"testing"

	"github.com/koinos/koinos-proto-golang/v2/koinos/protocol"
	"github.com/koinos/koinos-proto-golang/v2/koinos/rpc/block_store"
)

// Exercise the public handler with both backends. The original v1.1.0 panics
// when a skip-list entry points at a deleted record; the patched service must
// return an RPC error, keep the remaining records, and handle the next request.
func TestMissingHistoricalRecords(t *testing.T) {
	for _, backendType := range backendTypes {
		for _, rangeSize := range []uint32{1, 4} {
			t.Run(fmt.Sprintf("backend%d/range%d", backendType, rangeSize), func(t *testing.T) {
				backend := NewBackend(backendType)
				defer CloseBackend(backend)
				handler := &RequestHandler{Backend: backend}
				ids := make([][]byte, 9)
				for i := range ids { ids[i] = GetNonExistentBlockID(uint64(i + 1)) }
				for height := uint64(1); height <= 8; height++ {
					_, err := handler.AddBlock(&block_store.AddBlockRequest{BlockToAdd: &protocol.Block{
						Id: ids[height], Header: &protocol.BlockHeader{Height: height, Previous: ids[height-1]},
					}})
					if err != nil { t.Fatal(err) }
				}
				// Range 1 starts at an absent record; range 4 has a missing
				// predecessor after successfully reading the last block.
				missing := uint64(4)
				start := uint64(4)
				if rangeSize == 4 { missing = 3; start = 1 }
				before, err := backend.Get(ids[8])
				if err != nil { t.Fatal(err) }
				if err := backend.Delete(ids[missing]); err != nil { t.Fatal(err) }
				req := &block_store.GetBlocksByHeightRequest{HeadBlockId: ids[8], AncestorStartHeight: start, NumBlocks: rangeSize, ReturnBlock: true, ReturnReceipt: true}
				result, err := handler.GetBlocksByHeight(req)
				var absent *BlockNotPresent
				if !errors.As(err, &absent) || !bytes.Equal(absent.blockID, ids[missing]) || result != nil {
					t.Fatalf("expected precise missing-record error and no partial range: result=%v err=%v", result, err)
				}
				rpcResult := handler.HandleRequest(&block_store.BlockStoreRequest{Request: &block_store.BlockStoreRequest_GetBlocksByHeight{GetBlocksByHeight: req}})
				if rpcResult.GetError() == nil || rpcResult.GetError().GetMessage() != err.Error() { t.Fatalf("missing RPC error: %v", rpcResult) }
				healthy, err := handler.GetBlocksByHeight(&block_store.GetBlocksByHeightRequest{HeadBlockId: ids[8], AncestorStartHeight: 7, NumBlocks: 2, ReturnBlock: true})
				if err != nil || len(healthy.GetBlockItems()) != 2 || healthy.BlockItems[1].BlockHeight != 8 { t.Fatalf("next request failed: %v %v", healthy, err) }
				after, err := backend.Get(ids[8])
				if err != nil || !bytes.Equal(before, after) { t.Fatal("read request changed an existing record") }
				deleted, err := backend.Get(ids[missing])
				if err != nil || len(deleted) != 0 { t.Fatal("read request invented a missing record") }
			})
		}
	}
}
