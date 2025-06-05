const express = require("express");
const fetch = require("node-fetch");
const https = require("https");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_ID = process.env.WORKER || "node_004";
const SERVER_URL = "https://dienlanhquangphat.vn/toolvip";
const agent = new https.Agent({ rejectUnauthorized: false });

const WSOL = "So11111111111111111111111111111111111111112";
const DELAY_MS = 2400;
const ROUND_DELAY_MS = 500;
const BATCH_SIZE = 5;
const AMOUNT = 100_000_000;

let rpcUrls = [];

function loadRpcUrls() {
  try {
    const raw = fs.readFileSync("apikeys.txt", "utf-8");
    rpcUrls = raw.trim().split("\n").filter(Boolean);
    if (rpcUrls.length === 0) throw new Error("Không có RPC nào trong file.");
  } catch (e) {
    process.exit(1);
  }
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function callRpc(rpcUrl, method, params) {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function getTokenPriceViaQuickNode(mint, rpcUrl) {
  try {
    const largest = await callRpc(rpcUrl, "getTokenLargestAccounts", [mint]);
    const acc = largest?.result?.value?.[0];
    if (!acc) return null;

    const tokenAcc = acc.address;
    const accInfo = await callRpc(rpcUrl, "getAccountInfo", [tokenAcc, { encoding: "jsonParsed" }]);
    const parsed = accInfo?.result?.value?.data?.parsed?.info;
    const owner = parsed?.owner;
    const tokenAmount = parseFloat(parsed?.tokenAmount?.uiAmount || "0");
    if (!owner || tokenAmount === 0) return null;

    const wsolInfo = await callRpc(rpcUrl, "getTokenAccountsByOwner", [
      owner,
      { mint: WSOL },
      { encoding: "jsonParsed" },
    ]);
    const wsolAmount = parseFloat(
      wsolInfo?.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || "0"
    );

    if (wsolAmount > 0 && tokenAmount > 0) {
      return { value: +(wsolAmount / tokenAmount).toFixed(9), source: "QuickNode" };
    }
  } catch {}
  return null;
}

async function getTokenPriceWithTimeout(mint, timeout = 5000) {
  const rpc = rpcUrls[Math.floor(Math.random() * rpcUrls.length)];
  return Promise.race([
    getTokenPriceViaQuickNode(mint, rpc),
    new Promise(resolve => setTimeout(() => resolve(null), timeout))
  ]);
}

async function assignBatchTokens(batchSize) {
  try {
    const res = await fetch(`${SERVER_URL}/assign-token.php?worker=${WORKER_ID}&count=${batchSize}`, { agent });
    if (res.status === 204) return [];
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (data && data.mint) return [data];
    return [];
  } catch {
    return [];
  }
}

async function sendResults(results) {
  if (!results.length) return;
  try {
    await fetch(`${SERVER_URL}/update-token.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
      agent,
    });
  } catch {}
}

async function scanRound(round) {
  const scanTime = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  const tokens = await assignBatchTokens(BATCH_SIZE);
  if (!tokens.length) return;

  const results = [];
  const start = Date.now();

  for (const token of tokens) {
    const price = await getTokenPriceWithTimeout(token.mint);
    if (price) {
      results.push({
        mint: token.mint,
        index: token.index ?? undefined,
        currentPrice: price.value,
        scanTime
      });
    }

    if (Date.now() - start > 25000 && results.length > 0) {
      await sendResults(results);
      results.length = 0;
    }

    await delay(DELAY_MS);
  }

  if (results.length > 0) {
    await sendResults(results);
    results.length = 0;
  }
}

app.get("/", (req, res) => {
  res.send(`✅ WebCon [${WORKER_ID}] đang chạy`);
});

app.listen(PORT, () => {
  loadRpcUrls();
  let round = 1;
  (async function loop() {
    while (true) {
      await scanRound(round++);
      await delay(ROUND_DELAY_MS);
    }
  })();
});
