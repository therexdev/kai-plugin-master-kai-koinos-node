"use strict";
// The original seven-screen Node renderer is unchanged except its native
// secret presentation. Add the original app wallet's transaction history here,
// using the same verified WalletHistory service and pagination contract.
(() => {
  let identity="", cursor=null, rows=[], observed=0, pending=false, generation=0;
  const originalRenderWallet=renderWalletView;
  const current=()=>`${S.wallet?.address||""}:${S.appInfo?.settings?.network||""}`;
  const valid=version=>version===generation&&current()===identity&&S.view==="wallet";
  function clear(){identity=current();cursor=null;rows=[];observed=0;generation++;}
  function historyCard(){
    const view=document.getElementById("view-wallet");if(!view||!S.wallet?.exists||!S.wallet?.unlocked)return;
    if(current()!==identity)clear();
    if(document.getElementById("node-wallet-history"))return;
    const card=document.createElement("div");card.className="card";card.id="node-wallet-history";
    card.innerHTML='<div class="row spread"><h2>Transaction history</h2><button id="node-history-retry" class="btn ghost" hidden>Try again</button></div><p id="node-history-note" class="hint" role="status">Loading transaction history…</p><div class="table-wrap"><table><thead><tr><th>Activity</th><th>Amount</th><th>When</th><th>Status</th></tr></thead><tbody id="node-history-rows"></tbody></table></div><button id="node-history-more" class="btn" hidden>Load older transactions</button>';
    view.append(card);document.getElementById("node-history-retry").onclick=()=>refresh();document.getElementById("node-history-more").onclick=()=>refresh(true);draw();void refresh();
  }
  renderWalletView=function(...args){const result=originalRenderWallet(...args);historyCard();return result;};
  function draw(){
    const host=document.getElementById("node-history-rows");if(!host)return;
    host.replaceChildren();for(const row of rows){const tr=document.createElement("tr"),activity=document.createElement("td"),amount=document.createElement("td"),when=document.createElement("td"),status=document.createElement("td");
      const title=document.createElement("strong");title.textContent=row.label;activity.append(title);
      const reference=document.createElement("div");reference.className="mono small";reference.textContent=row.kind==="block"?"Block "+(row.height||""):shortTx(row.id);activity.append(reference);
      if(S.appInfo.settings.network==="mainnet"&&row.kind==="transaction"){const button=document.createElement("button");button.className="btn ghost";button.textContent="Explorer ↗";button.onclick=()=>call("util:openExternal",{url:"https://koinosblocks.com/tx/"+row.id}).catch(e=>toast(e.message,"bad"));activity.append(button);}
      if(row.counterparty){const party=document.createElement("div");party.className="mono small";party.textContent=row.counterparty;activity.append(party);}
      for(const change of row.changes){const line=document.createElement("div");line.className=change.direction==="in"?"good-text":"";line.textContent=(change.direction==="in"?"+":"−")+fmtSat(change.amount)+" "+change.asset;amount.append(line);}if(!row.changes.length)amount.textContent="—";
      when.textContent=row.timestamp===null?"Time unavailable":new Date(row.timestamp).toLocaleString();status.textContent=({confirmed:"Confirmed",confirming:"Confirming",failed:"Failed"})[row.status];tr.append(activity,amount,when,status);host.append(tr);
    }document.getElementById("node-history-more").hidden=!cursor;
  }
  async function refresh(older=false){
    if(pending||S.view!=="wallet"||!S.wallet?.address||!document.getElementById("node-wallet-history"))return;
    if(current()!==identity){clear();draw();}const version=generation, address=S.wallet.address,network=S.appInfo.settings.network;pending=true;
    const note=document.getElementById("node-history-note"),more=document.getElementById("node-history-more"),retry=document.getElementById("node-history-retry");more.disabled=true;retry.hidden=true;
    if(!observed||older)note.textContent=older?"Loading older transactions…":"Loading transaction history…";
    try{const result=await call("wallet:history",older?{cursor}:{});if(!valid(version))return;
      if(result.address!==address||result.network!==network||result.available!==true||!Array.isArray(result.rows)||result.rows.length>50)throw Error("Wallet history did not match the selected wallet and network");
      for(const row of result.rows){if(!row||!["transaction","block"].includes(row.kind)||!/^0x[0-9a-f]{68}$/i.test(row.id)||typeof row.label!=="string"||!["confirmed","confirming","failed"].includes(row.status)||!Array.isArray(row.changes))throw Error("Wallet history contained an invalid transaction");for(const c of row.changes)if(!["in","out"].includes(c.direction)||!/^\d+$/.test(c.amount)||!["KOIN","tKOIN","VHP"].includes(c.asset))throw Error("Wallet history contained an invalid amount");}
      rows=older?[...rows,...result.rows.filter(row=>!rows.some(old=>old.kind===row.kind&&old.id===row.id))]:result.rows;cursor=result.nextCursor;observed=result.observedAt;draw();note.textContent=rows.length?"On-chain activity · checked "+new Date(observed).toLocaleTimeString()+". Confirming transactions can still change.":cursor?"No transfers on this page. Load older transactions to continue.":"No transactions were found for this wallet on this network.";
    }catch(error){if(valid(version)){note.textContent=(rows.length?"Could not refresh. Showing previously loaded history. ":"Transaction history unavailable. ")+error.message;retry.hidden=false;}}
    finally{pending=false;if(more.isConnected)more.disabled=false;}
  }
  setInterval(()=>{if(current()!==identity){clear();draw();}if(S.view==="wallet"){historyCard();if(!observed||Date.now()-observed>30000)void refresh();}},3000);
  // Original transient notices retain their timing and gain a close control.
  const toasts=document.getElementById("toasts");if(toasts)new MutationObserver(()=>{for(const notice of toasts.children){if(notice.querySelector(".node-notice-close"))continue;const close=document.createElement("button");close.className="node-notice-close";close.type="button";close.setAttribute("aria-label","Dismiss notification");close.textContent="×";close.onclick=()=>notice.remove();notice.append(close);}}).observe(toasts,{childList:true});
})();
