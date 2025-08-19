/* Sniff Staking — Delegate Widget via Cloudflare Worker
 * RPC: Cloudflare Worker (проксі до Helius) — без CORS/401/403
 * Підтримка: Phantom, Solflare, Backpack, OKX, Exodus (інжектовані)
 *
 * Очікувані елементи в DOM (опціонально, з перевірками):
 *   #ssNetwork, #ssCommission, #ssActiveStake, #ssEpoch
 *   #ssConnectBtn, #ssDisconnectBtn, #ssBalance
 *   #ssAmount, #ssMaxBtn, #ssStakeBtn
 *   #ssStatus (рядок статусу/помилок)
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
  const fmt = (n, d=2) => {
    n = Number(n);
    return isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  };
  const httpContext = () => location.protocol.startsWith("http");

  // ====== STATE / CONNECTION ======
  const connection = new Connection(WORKER_RPC_URL, "confirmed");
  const state = { wallet: null, walletPubkey: null };

  // ====== Wallet detection ======
  function detectProvider() {
    try {
      if (window.phantom?.solana?.isPhantom) return { name:"Phantom",   provider: window.phantom.solana };
      if (window.solflare?.isSolflare)       return { name:"Solflare",  provider: window.solflare };
      if (window.backpack?.solana)           return { name:"Backpack",  provider: window.backpack.solana };
      if (window.okxwallet?.solana)          return { name:"OKX",       provider: window.okxwallet.solana };
      if (window.exodus?.solana)             return { name:"Exodus",    provider: window.exodus.solana };
      if (window.solana)                     return { name:"Generic",   provider: window.solana };
      return null;
    } catch { return null; }
  }
  async function doConnect(p) {
    if (typeof p.connect === "function") return await p.connect();
    if (typeof p.request === "function") return await p.request({ method: "connect" });
    throw new Error("Wallet provider does not support connect()");
  }
  function extractPubkey(p, resp) {
    const s = p?.publicKey?.toBase58?.()
           || p?.publicKey?.toString?.()
           || resp?.publicKey?.toBase58?.()
           || resp?.publicKey?.toString?.()
           || (typeof resp === "string" ? resp : null);
    if (!s) throw new Error("No publicKey from wallet");
    return new PublicKey(s);
  }

  // ====== Wallet actions ======
  async function connectWallet() {
    try {
      if (!httpContext()) { setStatus("Open site via http(s), not file://", true); return; }
      const found = detectProvider();
      if (!found) { setStatus("No wallet found. Install Phantom/Solflare.", true); return; }
      const resp = await doConnect(found.provider);
      const pk = extractPubkey(found.provider, resp);
      state.wallet = found.provider;
      state.walletPubkey = pk;
      if (connectBtn)    connectBtn.style.display = "none";
      if (disconnectBtn) disconnectBtn.style.display = "inline-block";
      await refreshWalletUI();
      setStatus("Wallet connected.");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Wallet connection failed.", true);
    }
  }
  async function disconnectWallet() {
    try { if (state.wallet?.disconnect) await state.wallet.disconnect(); } catch {}
    state.wallet = null; state.walletPubkey = null;
    if (connectBtn)    connectBtn.style.display = "inline-block";
    if (disconnectBtn) disconnectBtn.style.display = "none";
    if (balanceEl)     balanceEl.textContent = "—";
    setStatus("");
  }
  async function refreshWalletUI() {
    if (!state.walletPubkey || !balanceEl) return;
    const lamports = await connection.getBalance(state.walletPubkey);
    balanceEl.textContent = `${fmt(lamports / LAMPORTS_PER_SOL, 4)} SOL`;
  }

  // ====== Validator metrics ======
  async function loadValidatorInfo() {
    try {
      const votePk = new PublicKey(VALIDATOR_VOTE_PUBKEY);
      const voteAccounts = await connection.getVoteAccounts();
      const all = [...(voteAccounts.current || []), ...(voteAccounts.delinquent || [])];
      const mine = all.find(v => v.votePubkey === votePk.toBase58());

      if (commissionEl)  commissionEl.textContent  = mine ? `${mine.commission}%` : "—";
      if (activeStakeEl) activeStakeEl.textContent = mine && typeof mine.activatedStake === "number"
        ? `${fmt(mine.activatedStake / LAMPORTS_PER_SOL, 0)} SOL` : "—";

      const epochInfo = await connection.getEpochInfo();
      if (epochEl) epochEl.textContent = `${epochInfo.epoch}`;
    } catch (err) {
      console.error("loadValidatorInfo:", err);
      if (commissionEl)  commissionEl.textContent  = "—";
      if (activeStakeEl) activeStakeEl.textContent = "—";
      if (epochEl)       epochEl.textContent       = "—";
      setStatus("Could not load validator info (RPC).", true);
    }
  }

  // ====== Stake flow ======
  async function stakeNow() {
    try {
      setStatus("");
      if (!state.wallet || !state.walletPubkey) { setStatus("Connect wallet first.", true); return; }
      const amount = Number(amountEl?.value);
      if (!isFinite(amount) || amount <= 0) { setStatus("Enter a valid amount.", true); return; }

      // мінімум на ренту для stake account (~200 байт)
      const rentExempt = await connection.getMinimumBalanceForRentExemption(200);
      const lamports   = Math.floor(amount * LAMPORTS_PER_SOL);
      if (lamports < rentExempt + 5000) {
        setStatus(`Too low. Need ≥ ${(rentExempt / LAMPORTS_PER_SOL).toFixed(4)} SOL for rent.`, true);
        return;
      }

      setStatus("Preparing transaction…");
      const stakeAccount = Keypair.generate();

      const createIx = StakeProgram.createAccount({
        fromPubkey: state.walletPubkey,
        stakePubkey: stakeAccount.publicKey,
        authorized: new Authorized(state.walletPubkey, state.walletPubkey),
        lockup: new Lockup(0, 0, state.walletPubkey),
        lamports
      });

      const delegateIx = StakeProgram.delegate({
        stakePubkey: stakeAccount.publicKey,
        authorizedPubkey: state.walletPubkey,
        votePubkey: new PublicKey(VALIDATOR_VOTE_PUBKEY)
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ feePayer: state.walletPubkey, recentBlockhash: blockhash })
        .add(createIx, delegateIx);

      // важливо: підписати новий stake-акаунт
      tx.partialSign(stakeAccount);

      let signature;
      if (typeof state.wallet.signAndSendTransaction === "function") {
        const { signature: sig } = await state.wallet.signAndSendTransaction(tx);
        signature = sig;
      } else if (typeof state.wallet.signTransaction === "function") {
        const signed = await state.wallet.signTransaction(tx);
        signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight:false, maxRetries:3 });
      } else {
        throw new Error("Wallet cannot sign transactions.");
      }

      setStatus("Sending… " + signature.slice(0, 10) + "…");
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      setStatus("✅ Staked & delegated! Tx: " + signature.slice(0, 10) + "…");
      await refreshWalletUI();
    } catch (err) {
      console.error("stakeNow:", err);
      setStatus(err?.message || "Transaction failed.", true);
    }
  }

  // ====== MAX helper ======
  async function setMax() {
    if (!state.walletPubkey) { setStatus("Connect wallet first.", true); return; }
    const lamports = await connection.getBalance(state.walletPubkey);
    const keep = 0.01 * LAMPORTS_PER_SOL; // залишаємо ~0.01 SOL на фі
    const spendable = Math.max(0, lamports - keep);
    if (amountEl) amountEl.value = (spendable / LAMPORTS_PER_SOL).toFixed(4);
  }

  // ====== Init ======
  document.addEventListener("DOMContentLoaded", async () => {
    // метрики
    await loadValidatorInfo();
    setInterval(loadValidatorInfo, 60000);

    // кнопки (перевіряємо існування)
    if (connectBtn)    connectBtn.addEventListener("click", connectWallet);
    if (disconnectBtn) disconnectBtn.addEventListener("click", disconnectWallet);
    if (stakeBtn)      stakeBtn.addEventListener("click", stakeNow);
    if (maxBtn)        maxBtn.addEventListener("click", setMax);

    // автовідображення балансу при наявності сесії
    const found = detectProvider();
    if (found?.provider?.publicKey) {
      try {
        state.wallet = found.provider;
        state.walletPubkey = new PublicKey(found.provider.publicKey);
        if (connectBtn)    connectBtn.style.display = "none";
        if (disconnectBtn) disconnectBtn.style.display = "inline-block";
        await refreshWalletUI();
      } catch {}
    }

    // реакція на зміну акаунта
    found?.provider?.on?.("accountChanged", async () => {
      try {
        state.walletPubkey = found.provider.publicKey ? new PublicKey(found.provider.publicKey) : null;
        if (state.walletPubkey) await refreshWalletUI();
      } catch {}
    });
  });
})();
