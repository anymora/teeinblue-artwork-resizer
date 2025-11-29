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
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1833.jpg?v=1764169061";

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

// Nur heller Randhintergrund → transparent machen
async function removeBackgroundFloodFill(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  if (!width || !height) throw new Error("Ungültige Bildgröße");

  const raw = await img.raw().toBuffer(); // [r,g,b,a, ...]

  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 50));
  const stepY = Math.max(1, Math.floor(height / 50));

  function samplePixelAt(x, y) {
    const idx = (y * width + x) * 4;
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];
    const a = raw[idx + 3];
    if (a > 0) samples.push([r, g, b]);
  }

  // Rand abtasten
  for (let x = 0; x < width; x += stepX) {
    samplePixelAt(x, 0);
    samplePixelAt(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    samplePixelAt(0, y);
    samplePixelAt(width - 1, y);
  }

  if (!samples.length) return inputBuffer;

  // Cluster bilden
  const clusters = [];
  const maxClusterDist = 25;

  for (const col of samples) {
    let found = false;
    for (const cl of clusters) {
      if (colorDist(col, cl.color) < maxClusterDist) {
        cl.count++;
        cl.color[0] = Math.round((cl.color[0] * (cl.count - 1) + col[0]) / cl.count);
        cl.color[1] = Math.round((cl.color[1] * (cl.count - 1) + col[1]) / cl.count);
        cl.color[2] = Math.round((cl.color[2] * (cl.count - 1) + col[2]) / cl.count);
        found = true;
        break;
      }
    }
    if (!found) clusters.push({ color: [...col], count: 1 });
  }

  clusters.sort((a, b) => b.count - a.count);

  // Nur sehr helle Randfarben als Hintergrund zulassen
  const bgColors = clusters
    .filter((c) => brightness(c.color) > 200)
    .slice(0, 3)
    .map((c) => c.color);

  if (!bgColors.length) {
    // kein klarer heller Randhintergrund -> Original zurück
    return inputBuffer;
  }

  const visited = new Uint8Array(width * height);
  const queue = [];
  const TOL_START = 24;
  const TOL_GROW = 28;

  function isBgColor(r, g, b, tol) {
    return bgColors.some((bg) => colorDist([r, g, b], bg) < tol);
  }

  function tryEnqueue(x, y, tol) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idxPix = y * width + x;
    if (visited[idxPix]) return;

    const idx = idxPix * 4;
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];
    const a = raw[idx + 3];

    if (a === 0) {
      visited[idxPix] = 1;
      queue.push([x, y]);
      return;
    }

    if (brightness([r, g, b]) > 200 && isBgColor(r, g, b, tol)) {
      visited[idxPix] = 1;
      queue.push([x, y]);
    }
  }

  // Start vom Rand
  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0, TOL_START);
    tryEnqueue(x, height - 1, TOL_START);
  }
  for (let y = 0; y < height; y++) {
    tryEnqueue(0, y, TOL_START);
    tryEnqueue(width - 1, y, TOL_START);
  }

  // Flood-Fill
  while (queue.length) {
    const [cx, cy] = queue.pop();
    const neighbors = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const idxPix = ny * width + nx;
      if (visited[idxPix]) continue;

      const idx = idxPix * 4;
      const r = raw[idx];
      const g = raw[idx + 1];
      const b = raw[idx + 2];
      const a = raw[idx + 3];

      if (
        a === 0 ||
        (brightness([r, g, b]) > 200 && isBgColor(r, g, b, TOL_GROW))
      ) {
        visited[idxPix] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  // Hintergrund-Pixel transparent setzen
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idxPix = y * width + x;
      if (visited[idxPix]) {
        const idx = idxPix * 4;
        raw[idx + 3] = 0;
      }
    }
  }

  return sharp(raw, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

// transparentes Artwork + Mockup → PNG
async function makePreviewWithBgRemoval({ artworkUrl, mockupUrl, scale, offsetX, offsetY }) {
  // Artwork laden
  const artBuf = await loadImage(artworkUrl);

  // Hintergrund entfernen; wenn das schiefgeht, trotzdem PNG mit Alpha verwenden
  let artTransparent;
  try {
    artTransparent = await removeBackgroundFloodFill(artBuf);
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

  // Artwork auf Mockup compositen
  const finalBuf = await mockSharp
    .composite([{ input: scaled, left, top }])
    .png()
    .toBuffer();

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
      scale: 0.42,   // Größe auf Tasche
      offsetX: 0.26, // etwas nach links
      offsetY: 0.46, // etwas nach unten
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
      scale: 0.325,  // 25% größer als >0.26
      offsetX: 0.35, // etwas nach rechts
      offsetY: 0.37, // etwas nach unten
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

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
