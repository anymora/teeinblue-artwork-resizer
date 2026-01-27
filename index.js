// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Shopify CDN mag Browser-User-Agent
const SHOPIFY_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/*,*/*",
};

// Mockups
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358";

const TEE_WHITE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168";

const TEE_BLACK_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167";

const TEE_WHITE_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_wei_e_Shirt.png?v=1765367191";

const TEE_BLACK_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_schwarze_Shirt.png?v=1765367224";

const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer läuft.");
});

// --------------------- Hilfsfunktionen ---------------------

async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function brightness(r, g, b) {
  return (r + g + b) / 3;
}

function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

// --------------------- NEUE GRID-ENTFERNUNG ---------------------

async function removeGridBackgroundHeuristic(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();

  // 1) Vorfilter: Kandidatenmaske (grau/weiß, niedrige Sättigung)
  const candidate = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];

    if (
      brightness(r, g, b) > 170 &&
      saturation(r, g, b) < 0.12
    ) {
      candidate[i] = 1;
    }
  }

  // 2) Lokaler Strukturtest (kleinflächig = Grid)
  const GRID_AREA_MAX = 30; // px² – bewusst klein

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!candidate[i]) continue;

      let similar = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (candidate[(y + dy) * width + (x + dx)]) {
            similar++;
          }
        }
      }

      // isolierte / kleinflächige Muster = Grid
      if (similar <= GRID_AREA_MAX / 10) {
        raw[i * 4 + 3] = 0; // transparent
      }
    }
  }

  // 3) Sanfte Kanten (kein Ausfressen)
  return sharp(raw, {
    raw: { width, height, channels: 4 },
  })
    .blur(0.3)
    .png()
    .toBuffer();
}

// --------------------- Preview-Erstellung ---------------------

async function makePreviewWithBgRemoval({
  artworkUrl,
  mockupUrl,
  scale,
  offsetX,
  offsetY,
  overlayUrl,
}) {
  const artBuf = await loadImage(artworkUrl);

  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundHeuristic(artBuf);
  } catch (err) {
    console.error("BG-Removal Fehler:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();

  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale))
    .png()
    .toBuffer();

  const composites = [
    {
      input: scaled,
      left: Math.round(meta.width * offsetX),
      top: Math.round(meta.height * offsetY),
    },
  ];

  if (overlayUrl) {
    const overlay = await loadImage(overlayUrl);
    composites.push({ input: overlay, left: 0, top: 0 });
  }

  return mockSharp.composite(composites).png().toBuffer();
}

// --------------------- Endpoints ---------------------

app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl) return res.status(400).json({ error: "url fehlt" });

  const key = "TOTE_" + artworkUrl;
  if (previewCache.has(key)) return res.send(previewCache.get(key));

  const buf = await makePreviewWithBgRemoval({
    artworkUrl,
    mockupUrl: TOTE_MOCKUP_URL,
    scale: 0.42,
    offsetX: 0.26,
    offsetY: 0.46,
  });

  previewCache.set(key, buf);
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});

// (Mug / Tee Endpoints bleiben 1:1 gleich wie bei dir)

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
