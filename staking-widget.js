/* Sniff Staking — Delegate Widget with Preview & Simulate
 * RPC через Cloudflare Worker (проксі до Helius)
 */

(() => {
  const {
    Connection, PublicKey, StakeProgram,
    Authorized, Lockup, LAMPORTS_PER_SOL,
    Transaction, Keypair
  } = solanaWeb3;

  // ====== CONFIG ======
  const WORKER_RPC_URL = "https://lingering-base-a4ef.ann-kryvoshei.workers.dev";
  const VALIDATOR_VOTE_PUBKEY = "HXnHzBUQVZAmovjMb7vbm8G53XS3W4KVrzpF6jiozrJ3";
  const NETWORK_LABEL = "mainnet-beta";

  // ====== DOM helpers ======
  const $ = (id) => document.getElementById(id);
  const networkEl     = $("ssNetwork");
  const commissionEl  = $("ssCommission");
  const activeStakeEl = $("ssActiveStake");
  const epochEl       = $("ssEpoch");
  const connectBtn    = $("ssConnectBtn");
  const disconnectBtn = $("ssDisconnectBtn");
  const balanceEl     = $("ssBalance");
  const amountEl      = $("ssAmount");
  const maxBtn        = $("ssMaxBtn");
  const stakeBtn      = $("ssStakeBtn");
  const statusEl      = $("ssStatus");

  if (networkEl) networkEl.textContent = NETWORK_LABEL;

  const setStatus = (msg, isError=false) => {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color = isError ? "#ffb3b3" : "#cde2ff";
  };
  const fmt = (n, d=2) => isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";

  // ====== STATE ======
  const connection = new Connection(WORKER_RPC_URL, "confirmed");
  const state = { wallet: null, walletPubkey: null };

  // ====== Wallet detection ======
  function detectProvider() {
    try {
      if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
      if (window.solflare?.isSolflare) return window.solflare;
      if (window.backpack?.solana) return window.backpack.solana;
      if (window.okxwallet?.solana) return window.okxwallet.solana;
      if (window.exodus?.solana) return window.exodus.solana;
      if (window.solana) return window.solana;
      return null;
    } catch { return null; }
  }

  async function connectWallet() {
    try {
      const p = detectProvider();
      if (!p) { setStatus("No wallet found", true); return; }
      const resp = await (p.connect ? p.connect() : p.request({ method:"connect" }));
      const pk = new PublicKey(
        p.publicKey?.toBase58?.() || resp?.publicKey?.toBase58?.() || resp?.publicKey
      );
      state.wallet = p;
      state.walletPubkey = pk;
      connectBtn.style.display="none"; disconnectBtn.style.display="inline-block";
      await refreshWalletUI();
      setStatus("Wallet connected");
    } catch(e){ setStatus("Wallet connection failed", true); }
  }
  async function disconnectWallet(){
    try { if(state.wallet?.disconnect) await state.wallet.disconnect(); } catch{}
    state.wallet=null; state.walletPubkey=null;
    connectBtn.style.display="inline-block"; disconnectBtn.style.display="none";
    balanceEl.textContent="—"; setStatus("");
  }
  async function refreshWalletUI(){
    if (!state.walletPubkey) return;
    const lamports = await connection.getBalance(state.walletPubkey);
    balanceEl.textContent = `${fmt(lamports / LAMPORTS_PER_SOL,4)} SOL`;
  }

  // ====== Validator metrics ======
  async function loadValidatorInfo(){
    try {
      const voteAccounts = await connection.getVoteAccounts();
      const all = [...(voteAccounts.current||[]), ...(voteAccounts.delinquent||[])];
      const mine = all.find(v=>v.votePubkey===VALIDATOR_VOTE_PUBKEY);
      commissionEl.textContent = mine ? `${mine.commission}%` : "—";
      activeStakeEl.textContent = mine ? `${fmt(mine.activatedStake / LAMPORTS_PER_SOL,0)} SOL` : "—";
      const epochInfo = await connection.getEpochInfo();
      epochEl.textContent = `${epochInfo.epoch}`;
    } catch(e){
      commissionEl.textContent=activeStakeEl.textContent=epochEl.textContent="—";
    }
  }

  // ====== Preview Modal ======
  function openPreviewModal({ from, amountSol, fee, validator }){
    return new Promise((resolve)=>{
      const m = document.createElement("div");
      m.className="ss-modal";
      m.innerHTML=`
        <div class="ss-backdrop"></div>
        <div class="ss-box">
          <h3>Confirm Staking</h3>
          <p><b>From:</b> ${from}</p>
          <p><b>Validator:</b> ${validator}</p>
          <p><b>Amount:</b> ${amountSol} SOL</p>
          <p><b>Estimated Fee:</b> ${(fee/LAMPORTS_PER_SOL).toFixed(6)} SOL</p>
          <div class="ss-actions">
            <button id="ssConfirm">Confirm</button>
            <button id="ssCancel">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector("#ssConfirm").onclick=()=>{m.remove(); resolve(true)};
      m.querySelector("#ssCancel").onclick=()=>{m.remove(); resolve(false)};
    });
  }

  // ====== Stake flow with simulate (оновлено) ======
async function stakeNow(){
  try {
    setStatus(""); // очистимо статус

    if (!state.wallet || !state.walletPubkey) {
      setStatus("Connect wallet", true);
      return;
    }

    const amount = Number(amountEl.value);
    if (!isFinite(amount) || amount <= 0) {
      setStatus("Enter valid amount", true);
      return;
    }

    // мінімум на ренту для stake account (~200 байт)
    const rentExempt = await connection.getMinimumBalanceForRentExemption(200);
    const lamports   = Math.floor(amount * LAMPORTS_PER_SOL);
    if (lamports < rentExempt + 5000) {
      setStatus(`Too low (need ≥ ${(rentExempt / LAMPORTS_PER_SOL).toFixed(4)} SOL for rent)`, true);
      return;
    }

    // 1) готуємо новий stake-акаунт і інструкції
    const stakeAccount = Keypair.generate();
    const createIx = StakeProgram.createAccount({
      fromPubkey: state.walletPubkey,
      stakePubkey: stakeAccount.publicKey,
      authorized: new Authorized(state.walletPubkey, state.walletPubkey),
      lockup: new Lockup(0,0,state.walletPubkey),
      lamports
    });
    const delegateIx = StakeProgram.delegate({
      stakePubkey: stakeAccount.publicKey,
      authorizedPubkey: state.walletPubkey,
      votePubkey: new PublicKey(VALIDATOR_VOTE_PUBKEY)
    });

    // 2) СИМУЛЯЦІЯ: завжди беремо свіжий blockhash, підписуємо stakeAccount + wallet
    const { blockhash: simBlockhash } = await connection.getLatestBlockhash("finalized");
    const txSim = new Transaction({ feePayer: state.walletPubkey, recentBlockhash: simBlockhash })
      .add(createIx, delegateIx);
    txSim.partialSign(stakeAccount);

    // Симулюємо з підписом гаманця, щоб не завалитися на sigVerify
    let feeLamports = 5000;
    try {
      const signedForSim = await state.wallet.signTransaction(txSim);
      const sim = await connection.simulateTransaction(signedForSim, { sigVerify: true });
      // деякі RPC повертають fee у симуляції; якщо ні — спробуємо порахувати через message fee
      if (sim.value?.fee != null) {
        feeLamports = sim.value.fee;
      } else {
        try {
          const feeResp = await connection.getFeeForMessage(signedForSim.compileMessage());
          if (feeResp?.value != null) feeLamports = feeResp.value;
        } catch {}
      }
      if (sim.value?.err) {
        setStatus(`Simulation error: ${JSON.stringify(sim.value.err)}`, true);
        return;
      }
    } catch (e) {
      // якщо симуляція не вдалась — не блокуємо, але попереджаємо
      console.warn("simulateTransaction failed:", e);
    }

    // 3) превʼю: показуємо модалку з підсумком (використовуємо твою modal-функцію)
    const ok = await openPreviewModal({
      from: state.walletPubkey.toBase58(),
      amountSol: amount,
      fee: feeLamports,
      validator: VALIDATOR_VOTE_PUBKEY
    });
    if (!ok) { setStatus("Cancelled"); return; }

    // 4) ВІДПРАВКА: створюємо НОВУ транзакцію зі свіжим blockhash (щоб не протухла),
    // знову додаємо ті ж інструкції, підписуємо stakeAccount і гаманець.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const txSend = new Transaction({ feePayer: state.walletPubkey, recentBlockhash: blockhash })
      .add(createIx, delegateIx);
    txSend.partialSign(stakeAccount);

    let signature;
    if (state.wallet.signAndSendTransaction) {
      const { signature: sig } = await state.wallet.signAndSendTransaction(txSend);
      signature = typeof sig === "string" ? sig : (Array.isArray(sig) ? sig[0] : String(sig));
    } else {
      const signed = await state.wallet.signTransaction(txSend);
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight:false, maxRetries:3 });
    }

    setStatus("Sending… " + signature.slice(0,10) + "…");
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    setStatus("✅ Staked & delegated! Tx: " + signature.slice(0,10) + "…");

    await refreshWalletUI();
  } catch(e){
    console.error("stakeNow error:", e);
    setStatus(e?.message || "Tx failed", true);
  }
}

  // ====== MAX helper ======
  async function setMax(){
    if (!state.walletPubkey) return;
    const lamports = await connection.getBalance(state.walletPubkey);
    const spendable = Math.max(0, lamports - 0.01*LAMPORTS_PER_SOL);
    amountEl.value=(spendable/LAMPORTS_PER_SOL).toFixed(4);
  }

  // ====== Init ======
  document.addEventListener("DOMContentLoaded", async ()=>{
    await loadValidatorInfo();
    setInterval(loadValidatorInfo,60000);
    connectBtn?.addEventListener("click", connectWallet);
    disconnectBtn?.addEventListener("click", disconnectWallet);
    stakeBtn?.addEventListener("click", stakeNow);
    maxBtn?.addEventListener("click", setMax);
  });
})();




