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

// --------------------- NEUE GRID-DE-COMPOSITING-LOGIK ---------------------

async function removeGridBackgroundDecomposite(inputBuffer) {
  const MAX_SIZE = 9;          // Grid max ~6px, JPEG-Toleranz
  const MIN_BRIGHT = 130;      // deutlich runter
  const COLOR_TOL = 40;        // JPEG realistisch

  const img = sharp(inputBuffer).ensureAlpha();
  const { width, height } = await img.metadata();
  if (!width || !height) throw new Error("Ungültige Bildgröße");

  const raw = await img.raw().toBuffer();

  const visited = new Uint8Array(width * height);
  const remove  = new Uint8Array(width * height);

  const idx = (x, y) => y * width + x;
  const p   = (i) => i * 4;

  function isGrayish(i) {
    const r = raw[p(i)];
    const g = raw[p(i) + 1];
    const b = raw[p(i) + 2];
    const br = (r + g + b) / 3;

    return (
      br >= MIN_BRIGHT &&
      Math.abs(r - g) <= COLOR_TOL &&
      Math.abs(r - b) <= COLOR_TOL &&
      Math.abs(g - b) <= COLOR_TOL
    );
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y);
      if (visited[start] || !isGrayish(start)) continue;

      const stack = [start];
      const comp = [];

      let minX = x, maxX = x, minY = y, maxY = y;
      visited[start] = 1;

      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);

        const cx = cur % width;
        const cy = Math.floor(cur / width);

        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const ni = idx(nx, ny);
          if (!visited[ni] && isGrayish(ni)) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;

      // ✅ NUR HIER ENTSCHEIDEN
      if (w <= MAX_SIZE && h <= MAX_SIZE) {
        for (const i of comp) remove[i] = 1;
      }
    }
  }

  for (let i = 0; i < remove.length; i++) {
    if (remove[i]) raw[p(i) + 3] = 0;
  }

  return sharp(raw, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
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
  // Artwork laden
  const artBuf = await loadImage(artworkUrl);

  // NEU: Grid-De-Compositing statt Flood-Fill
  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundDecomposite(artBuf);
  } catch (err) {
    console.error("BG-Removal Fehler, verwende Original mit Alpha:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  // Mockup laden
  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Konnte Mockup-Größe nicht lesen.");
  }

  // Artwork skalieren
  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const left = Math.round(meta.width * offsetX);
  const top = Math.round(meta.height * offsetY);

  const composites = [{ input: scaled, left, top }];

  // Falls Overlay gesetzt: PNG über alles legen
  if (overlayUrl) {
    const overlayBuf = await loadImage(overlayUrl);
    const overlayPng = await sharp(overlayBuf).ensureAlpha().png().toBuffer();
    composites.push({
      input: overlayPng,
      left: 0,
      top: 0,
    });
  }

  // Artwork (und ggf. Overlay) auf Mockup compositen
  const finalBuf = await mockSharp.composite(composites).png().toBuffer();

  return finalBuf;
}

// --------------------- Tote Endpoint ---------------------

app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TOTE_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TOTE_MOCKUP_URL,
      scale: 0.42,
      offsetX: 0.26,
      offsetY: 0.46,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Mug Endpoint ---------------------

app.get("/mug-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "MUG_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: MUG_MOCKUP_URL,
      scale: 0.325,
      offsetX: 0.35,
      offsetY: 0.39,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /mug-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /mug-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee weiß Endpoint ---------------------

app.get("/tee-white-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_WHITE_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TEE_WHITE_MOCKUP_URL,
      scale: 0.36,
      offsetX: 0.31,
      offsetY: 0.26,
      overlayUrl: TEE_WHITE_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-white-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-white-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee schwarz Endpoint ---------------------

app.get("/tee-black-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_BLACK_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TEE_BLACK_MOCKUP_URL,
      scale: 0.36,
      offsetX: 0.31,
      offsetY: 0.26,
      overlayUrl: TEE_BLACK_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-black-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-black-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
