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

  // ====== Stake flow with simulate ======
  async function stakeNow(){
    try {
      if (!state.walletPubkey) { setStatus("Connect wallet",true); return; }
      const amount = Number(amountEl.value);
      if (!isFinite(amount)||amount<=0) { setStatus("Enter valid amount",true); return; }

      const rentExempt = await connection.getMinimumBalanceForRentExemption(200);
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      if (lamports < rentExempt + 5000) {
        setStatus("Too low (need rent exempt).", true); return;
      }

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
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ feePayer: state.walletPubkey, recentBlockhash:blockhash }).add(createIx, delegateIx);
      tx.partialSign(stakeAccount);

      // simulate before send
      let fee=5000;
      try {
        const sim = await connection.simulateTransaction(tx);
        fee = sim.value?.fee || fee;
      } catch(e){}

      const ok = await openPreviewModal({
        from: state.walletPubkey.toBase58(),
        amountSol: amount,
        fee,
        validator: VALIDATOR_VOTE_PUBKEY
      });
      if (!ok) { setStatus("Cancelled"); return; }

      // send
      let signature;
      if (state.wallet.signAndSendTransaction) {
        const { signature:sig } = await state.wallet.signAndSendTransaction(tx);
        signature=sig;
      } else {
        const signed = await state.wallet.signTransaction(tx);
        signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight:false });
      }
      setStatus("Sending… " + signature.slice(0,10)+"…");
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      setStatus("✅ Staked! Tx: "+signature.slice(0,10)+"…");
      await refreshWalletUI();
    } catch(e){ setStatus(e.message||"Tx failed",true); }
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

