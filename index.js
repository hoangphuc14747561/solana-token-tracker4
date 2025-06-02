const express = require("express");
const fetch = require("node-fetch");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_ID = process.env.WORKER || "node_004";
const SERVER_URL = "https://dienlanhquangphat.vn/toolvip";

const agent = new https.Agent({ rejectUnauthorized: false });

const WSOL = "So11111111111111111111111111111111111111112";
const AMOUNT = 100_000_000;
const DELAY_MS = 2400;
const ROUND_DELAY_MS = 500;
const BATCH_SIZE = 5;

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function getLocalTime() {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}

async function getRaydiumPairs() {
  try {
    const res = await fetch("https://api-v3.raydium.io/pairs");
    return await res.json();
  } catch {
    return [];
  }
}

async function getTokenPrice(mint, rayPairs) {
  let jupiter = null, raydium = null;
  try {
    const q = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${AMOUNT}&slippageBps=300`);
    const data = await q.json();
    if (data.outAmount) {
      const price = parseFloat(data.outAmount) / AMOUNT;
      jupiter = { value: +price.toFixed(9), source: "Jupiter" };
    }
  } catch {}

  try {
    const check = await fetch(`https://api-v3.raydium.io/mint/ids?mints=${mint}`);
    const valid = await check.json();
    if (valid.length > 0) {
      const p = rayPairs.find(p => p.baseMint === mint || p.quoteMint === mint);
      if (p && p.price && p.quoteMint === WSOL) {
        raydium = { value: +parseFloat(p.price).toFixed(9), source: "Raydium" };
      }
    }
  } catch {}

  if (jupiter && raydium) return raydium.value > jupiter.value ? raydium : jupiter;
  return jupiter || raydium || null;
}

// ✅ Bọc getTokenPrice để tránh treo (timeout sau 5s)
async function getTokenPriceWithTimeout(mint, rayPairs, timeout = 5000) {
  return Promise.race([
    getTokenPrice(mint, rayPairs),
    new Promise(resolve => setTimeout(() => resolve(null), timeout))
  ]);
}

async function assignBatchTokens(batchSize) {
  try {
    const res = await fetch(`${SERVER_URL}/assign-token.php?worker=${WORKER_ID}&count=${batchSize}`, { agent });
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (data && data.mint) return [data];
    return [];
  } catch (err) {
    console.error("❌ Lỗi khi gọi assign-token.php:", err.message);
    return [];
  }
}

async function sendResults(results) {
  if (results.length === 0) return;
  try {
    await fetch(`${SERVER_URL}/update-token.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
      agent
    });
    console.log(`🚀 Đã gửi ${results.length} token`);
  } catch (e) {
    console.error("❌ Gửi thất bại:", e.message);
  }
}

async function scanRound(round) {
  try {
    const rayPairs = await getRaydiumPairs();
    const scanTime = getLocalTime();
    const tokens = await assignBatchTokens(BATCH_SIZE);

    if (tokens.length === 0) {
      console.log("⏳ Không có token nào pending...");
      return;
    }

    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const price = await getTokenPriceWithTimeout(token.mint, rayPairs, 5000);
      if (price) {
        console.log(`✅ [${token.mint}] Giá: ${price.value} (${price.source})`);
        results.push({
          mint: token.mint,
          index: token.index ?? undefined,
          currentPrice: price.value,
          scanTime: scanTime
        });
      } else {
        console.log(`❌ Bỏ qua token bị treo hoặc lỗi: ${token.mint}`);
      }

      const elapsed = Date.now() - startTime;
      if (results.length > 0 && elapsed > 25000) {
        console.log(`⚠️ Gửi sớm vì gần hết thời gian...`);
        await sendResults(results);
        results.length = 0;
      }

      await delay(DELAY_MS);
    }

    // ✅ Gửi nốt những token chưa gửi
    if (results.length > 0) {
      await sendResults(results);
    }

  } catch (err) {
    console.error("❌ Scan error:", err.message);
  }
}

app.get("/", (req, res) => {
  res.send(`✅ WebCon [${WORKER_ID}] đang chạy.`);
});

app.listen(PORT, () => {
  console.log(`✅ WebCon (worker=${WORKER_ID}) listening on port ${PORT}`);
  let round = 1;
  (async function loop() {
    while (true) {
      console.log(`🔁 Round ${round++}`);
      await scanRound(round);
      await delay(ROUND_DELAY_MS);
    }
  })();
});
