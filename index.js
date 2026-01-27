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

function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function brightness(c) {
  return (c[0] + c[1] + c[2]) / 3;
}

// --------------------- GRID-LOGIK (ERSATZ DER ALTEN FUNKTION) ---------------------

async function removeGridBackgroundDecomposite(inputBuffer) {
  const MAX_SIZE = 6;          // max. Breite/Höhe eines Grid-Elements
  const BRIGHT_MIN = 190;      // helles Grau
  const BRIGHT_MAX = 255;      // Weiß
  const COLOR_TOL = 15;

  const img = sharp(inputBuffer).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  if (!width || !height) {
    throw new Error("Ungültige Bildgröße");
  }

  const raw = await img.raw().toBuffer(); // [r,g,b,a]
  const visited = new Uint8Array(width * height);
  const isGrid = new Uint8Array(width * height);

  const idx = (x, y) => y * width + x;
  const p = (i) => i * 4;

  function isGridCandidate(i) {
    const r = raw[p(i)];
    const g = raw[p(i) + 1];
    const b = raw[p(i) + 2];
    const br = (r + g + b) / 3;
    return (
      br >= BRIGHT_MIN &&
      br <= BRIGHT_MAX &&
      Math.abs(r - g) < COLOR_TOL &&
      Math.abs(r - b) < COLOR_TOL &&
      Math.abs(g - b) < COLOR_TOL
    );
  }

  // Connected Components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y);
      if (visited[start] || !isGridCandidate(start)) continue;

      let minX = x, maxX = x, minY = y, maxY = y;
      const stack = [start];
      const component = [];

      visited[start] = 1;

      while (stack.length) {
        const cur = stack.pop();
        component.push(cur);

        const cx = cur % width;
        const cy = Math.floor(cur / width);

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
          if (!visited[ni] && isGridCandidate(ni)) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }

      if ((maxX - minX) <= MAX_SIZE && (maxY - minY) <= MAX_SIZE) {
        for (const i of component) {
          isGrid[i] = 1;
        }
      }
    }
  }

  // Inpainting (Median der Nachbarn)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = idx(x, y);
      if (!isGrid[i]) continue;

      const rs = [], gs = [], bs = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = idx(x + dx, y + dy);
          if (!isGrid[ni]) {
            rs.push(raw[p(ni)]);
            gs.push(raw[p(ni) + 1]);
            bs.push(raw[p(ni) + 2]);
          }
        }
      }

      if (rs.length) {
        rs.sort((a,b)=>a-b);
        gs.sort((a,b)=>a-b);
        bs.sort((a,b)=>a-b);
        raw[p(i)]     = rs[Math.floor(rs.length / 2)];
        raw[p(i) + 1] = gs[Math.floor(gs.length / 2)];
        raw[p(i) + 2] = bs[Math.floor(bs.length / 2)];
      }
    }
  }

  return sharp(raw, {
    raw: { width, height, channels: 4 },
  })
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
  overlayUrl, // optional
}) {
  const artBuf = await loadImage(artworkUrl);

  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundDecomposite(artBuf);
  } catch (err) {
    console.error("BG-Removal Fehler, verwende Original mit Alpha:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();

  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const composites = [{
    input: scaled,
    left: Math.round(meta.width * offsetX),
    top: Math.round(meta.height * offsetY),
  }];

  if (overlayUrl) {
    const overlayBuf = await loadImage(overlayUrl);
    const overlayPng = await sharp(overlayBuf).ensureAlpha().png().toBuffer();
    composites.push({ input: overlayPng, left: 0, top: 0 });
  }

  return mockSharp.composite(composites).png().toBuffer();
}

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
