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

// Mockups (aktualisiert wie im zweiten Backend)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358";

// NEU: T-Shirt Mockups
const TEE_WHITE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168";

const TEE_BLACK_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167";

// NEU: Overlays für T-Shirts (PNG oben drauf)
const TEE_WHITE_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_wei_e_Shirt.png?v=1765367191";

const TEE_BLACK_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_schwarze_Shirt.png?v=1765367224";

// Cache: artworkUrl + type -> fertiges PNG
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (BG-Removal + Tasche + Tasse) läuft.");
});

// --------------------- Hilfsfunktionen ---------------------

async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function brightness(r, g, b) {
  return (r + g + b) / 3;
}

// --------------------- GRID-ENTFERNUNG (FINAL, STABIL) ---------------------

async function removeGridPatternByComponents(inputBuffer) {
  const MAX_SIZE = 6;              // max 6x6 px
  const BRIGHT_MIN = 190;          // hellgrau
  const BRIGHT_MAX = 255;
  const COLOR_TOL = 15;

  const img = sharp(inputBuffer).ensureAlpha();
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();

  const visited = new Uint8Array(width * height);
  const isGridPixel = new Uint8Array(width * height);

  const idx = (x, y) => y * width + x;
  const px = (i) => i * 4;

  function isCandidate(i) {
    const r = raw[px(i)];
    const g = raw[px(i) + 1];
    const b = raw[px(i) + 2];
    const br = brightness(r, g, b);
    return br >= BRIGHT_MIN && br <= BRIGHT_MAX &&
           Math.abs(r - g) < COLOR_TOL &&
           Math.abs(r - b) < COLOR_TOL;
  }

  // --- Connected Components ---
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y);
      if (visited[start] || !isCandidate(start)) continue;

      let minX = x, maxX = x, minY = y, maxY = y;
      const stack = [start];
      const component = [];

      visited[start] = 1;

      while (stack.length) {
        const p = stack.pop();
        component.push(p);
        const cx = p % width;
        const cy = Math.floor(p / width);

        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        if (maxX - minX > MAX_SIZE || maxY - minY > MAX_SIZE) break;

        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny);
          if (!visited[ni] && isCandidate(ni)) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }

      if ((maxX - minX) <= MAX_SIZE && (maxY - minY) <= MAX_SIZE) {
        for (const p of component) {
          isGridPixel[p] = 1;
        }
      }
    }
  }

  // --- Ersetzen durch Nachbar-Median ---
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = idx(x, y);
      if (!isGridPixel[i]) continue;

      const rs = [], gs = [], bs = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = idx(x + dx, y + dy);
          if (!isGridPixel[ni]) {
            rs.push(raw[px(ni)]);
            gs.push(raw[px(ni) + 1]);
            bs.push(raw[px(ni) + 2]);
          }
        }
      }

      if (rs.length) {
        rs.sort((a,b)=>a-b);
        gs.sort((a,b)=>a-b);
        bs.sort((a,b)=>a-b);
        raw[px(i)]     = rs[Math.floor(rs.length / 2)];
        raw[px(i) + 1] = gs[Math.floor(gs.length / 2)];
        raw[px(i) + 2] = bs[Math.floor(bs.length / 2)];
      }
    }
  }

  return sharp(raw, { raw: { width, height, channels: 4 } })
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
    artTransparent = await removeGridPatternByComponents(artBuf);
  } catch (e) {
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();

  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale))
    .png()
    .toBuffer();

  const composites = [{
    input: scaled,
    left: Math.round(meta.width * offsetX),
    top: Math.round(meta.height * offsetY),
  }];

  if (overlayUrl) {
    const overlay = await loadImage(overlayUrl);
    composites.push({ input: overlay, left: 0, top: 0 });
  }

  return mockSharp.composite(composites).png().toBuffer();
}

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
