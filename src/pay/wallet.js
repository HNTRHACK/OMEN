// The player's EVM wallet (any EIP-1193 browser wallet). Reads go to Whitechain's public RPC;
// anything that moves funds is signed in the wallet, never here. OMEN holds no keys.

import { createPublicClient, createWalletClient, custom, http, erc20Abi, defineChain, getAddress, isAddress, parseUnits, formatUnits } from "viem";
import { WHITECHAIN, USDT } from "../../shared/chains.js";

// VITE_WHITECHAIN_RPC lets a local fork stand in for the public RPC (see README "Verify locally").
const RPC = import.meta.env.VITE_WHITECHAIN_RPC || WHITECHAIN.rpc;

export const whitechain = defineChain({
  id: WHITECHAIN.id,
  name: WHITECHAIN.name,
  nativeCurrency: WHITECHAIN.native,
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Whitechain Explorer", url: WHITECHAIN.explorer } },
  testnet: true,
});

const CHECKOUT_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "merchantId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "inrPaise", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "merchants", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "payout", type: "address" }, { name: "active", type: "bool" }] },
  // Registered merchants AND direct ids (player shops: the id embeds the payout address). `merchants`
  // alone can't see a direct id, so every shop payment would have been refused as "not registered".
  { type: "function", name: "merchantOf", stateMutability: "view", inputs: [{ name: "merchantId", type: "bytes32" }], outputs: [{ type: "tuple", components: [{ name: "payout", type: "address" }, { name: "active", type: "bool" }] }] },
];

const listeners = new Set();
const announced = [];
addEventListener("eip6963:announceProvider", (e) => announced.push(e.detail));
dispatchEvent(new Event("eip6963:requestProvider"));

export const wallet = {
  provider: null,
  address: null,
  chainId: null,
  name: null,
  pub: createPublicClient({ chain: whitechain, transport: http(RPC) }),

  available() {
    return !!(announced[0]?.provider || window.ethereum);
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit() {
    for (const fn of listeners) fn(wallet);
  },

  async connect() {
    const pick = announced[0];
    const provider = pick?.provider || window.ethereum;
    if (!provider) throw new Error("No browser wallet found. Install MetaMask, Rabby or another EVM wallet, or play with DEMO credits.");
    const [addr] = await provider.request({ method: "eth_requestAccounts" });
    if (!isAddress(addr || "")) throw new Error("The wallet didn't share an account.");
    wallet.provider = provider;
    wallet.name = pick?.info?.name || (provider.isMetaMask ? "MetaMask" : "Browser wallet");
    wallet.address = getAddress(addr);
    wallet.chainId = Number(await provider.request({ method: "eth_chainId" }));
    provider.on?.("accountsChanged", (a) => {
      wallet.address = a?.[0] ? getAddress(a[0]) : null;
      wallet.emit();
    });
    provider.on?.("chainChanged", (c) => {
      wallet.chainId = Number(c);
      wallet.emit();
    });
    wallet.emit();
    return wallet.address;
  },

  disconnect() {
    wallet.provider = wallet.address = wallet.chainId = null;
    wallet.emit();
  },

  /** Switch the wallet to `chain`, adding it first if the wallet doesn't know it. */
  async ensureChain(chain) {
    const hex = "0x" + chain.id.toString(16);
    if (Number(await wallet.provider.request({ method: "eth_chainId" })) === chain.id) return;
    try {
      await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
      await wallet.provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [] }],
      });
    }
    wallet.chainId = chain.id;
  },

  client(chain = whitechain) {
    return createWalletClient({ account: wallet.address, chain, transport: custom(wallet.provider) });
  },

  async balances() {
    if (!wallet.address) return null;
    const [wbt, usdt] = await Promise.all([
      wallet.pub.getBalance({ address: wallet.address }),
      wallet.pub.readContract({ address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }),
    ]);
    return { WBT: wbt, USDT: usdt };
  },

  /**
   * Pay an authorized order through OmenCheckout: approve exactly the amount if needed, then pay.
   * `onStep(name)` reports progress for the UI and the in-world journey.
   */
  async payCheckout(checkout, c, onStep = () => {}) {
    await wallet.ensureChain(whitechain);
    const w = wallet.client();
    const amount = BigInt(c.amount);
    // Don't take the server's word for where to send an approval: check the contract on-chain.
    const [token, m] = await Promise.all([
      wallet.pub.readContract({ address: checkout, abi: CHECKOUT_ABI, functionName: "token" }).catch(() => null),
      wallet.pub.readContract({ address: checkout, abi: CHECKOUT_ABI, functionName: "merchantOf", args: [c.merchantKey] }).catch(() => ({ active: false })),
    ]);
    if (!token || getAddress(token) !== getAddress(USDT.address)) throw new Error("The checkout contract doesn't accept the official test USDT. Refusing to approve anything.");
    if (!m.active) throw new Error("This merchant isn't registered on the checkout contract. Nothing was approved.");
    const bal = await wallet.pub.readContract({ address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
    if (bal < amount) throw new Error(`Not enough test USDT: you have ${formatUnits(bal, USDT.decimals)}, this needs ${formatUnits(amount, USDT.decimals)}.`);
    const allowance = await wallet.pub.readContract({ address: USDT.address, abi: erc20Abi, functionName: "allowance", args: [wallet.address, checkout] });
    if (allowance < amount) {
      onStep("approve");
      // USDT-style tokens can refuse changing a non-zero allowance; reset to zero first.
      if (allowance > 0n) await wallet.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "approve", args: [checkout, 0n] }) });
      const ah = await w.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "approve", args: [checkout, amount] });
      await wallet.pub.waitForTransactionReceipt({ hash: ah });
    }
    onStep("pay");
    const hash = await w.writeContract({
      address: checkout,
      abi: CHECKOUT_ABI,
      functionName: "pay",
      args: [c.orderId, c.merchantKey, amount, BigInt(c.inrPaise), BigInt(c.deadline)],
    });
    onStep("sent", hash);
    const receipt = await wallet.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw Object.assign(new Error("The payment transaction reverted."), { hash });
    return hash;
  },

  /**
   * Gasless checkout: sign the EIP-3009 authorization the gateway prepared. This is an off-chain
   * signature, not a transaction: the payer spends no WBT. Before asking the wallet, check every
   * term ourselves so a misbehaving server can't get anything else signed.
   */
  async signAuthorization(checkout, td, quote, merchantKey) {
    await wallet.ensureChain(whitechain); // wallets require the domain's chain to be active
    const m = td.message;
    const same = (a, b) => getAddress(a) === getAddress(b);
    if (td.primaryType !== "ReceiveWithAuthorization") throw new Error("Unexpected signature request. Nothing was signed.");
    if (td.domain.chainId !== WHITECHAIN.id || !same(td.domain.verifyingContract, USDT.address) || td.domain.name !== "Tether USD")
      throw new Error("The signature request isn't for Whitechain's official test USDT. Nothing was signed.");
    if (!same(m.from, wallet.address)) throw new Error("The signature request is for another wallet. Nothing was signed.");
    if (!same(m.to, checkout)) throw new Error("The signature request doesn't pay the checkout contract. Nothing was signed.");
    if (m.value !== String(quote.tokenUnits)) throw new Error("The amount to sign differs from the quote. Nothing was signed.");
    await wallet.checkCheckout(checkout, merchantKey);
    return wallet.client().signTypedData({
      account: wallet.address,
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) },
    });
  },

  /** On-chain check that `checkout` takes official test USDT and knows the merchant. */
  async checkCheckout(checkout, merchantKey) {
    const [token, m] = await Promise.all([
      wallet.pub.readContract({ address: checkout, abi: CHECKOUT_ABI, functionName: "token" }).catch(() => null),
      merchantKey ? wallet.pub.readContract({ address: checkout, abi: CHECKOUT_ABI, functionName: "merchantOf", args: [merchantKey] }).catch(() => ({ active: false })) : { active: true },
    ]);
    if (!token || getAddress(token) !== getAddress(USDT.address)) throw new Error("The checkout contract doesn't accept the official test USDT. Refusing to sign anything.");
    if (!m.active) throw new Error("This merchant isn't registered on the checkout contract. Nothing was signed.");
  },

  async usdtBalance() {
    if (!wallet.address) return null;
    return wallet.pub.readContract({ address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
  },

  /** Send WBT or USDT to another address on Whitechain Sepolia. */
  async transfer(token, to, amountText) {
    if (!isAddress(to)) throw new Error("That isn't a valid address.");
    await wallet.ensureChain(whitechain);
    const w = wallet.client();
    const hash =
      token === "WBT"
        ? await w.sendTransaction({ to: getAddress(to), value: parseUnits(amountText, 18) })
        : await w.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "transfer", args: [getAddress(to), parseUnits(amountText, USDT.decimals)] });
    const r = await wallet.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transfer reverted.");
    return hash;
  },
};
