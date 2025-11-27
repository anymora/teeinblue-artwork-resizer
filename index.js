// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Shopify CDN mag einen Browser-User-Agent lieber
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

// In-Memory-Cache
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (BG-Removal + Tasche + Tasse) läuft.");
});

// --------------------------------------------------
// Hilfsfunktion: Bild von URL laden
// --------------------------------------------------
async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

// --------------------------------------------------
// Farb-Distanz
// --------------------------------------------------
function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function brightness(c) {
  return (c[0] + c[1] + c[2]) / 3; // 0..255
}

// --------------------------------------------------
// Hintergrund entfernen (nur heller Rand → transparent)
// --------------------------------------------------
async function removeBackgroundFloodFill(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  if (!width || !height) {
    throw new Error("Konnte Bildgröße nicht bestimmen.");
  }

  const raw = await img.raw().toBuffer(); // [r,g,b,a, r,g,b,a, ...]

  // 1. Randpixel sampeln → Hintergrundfarben clustern
  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 50));
  const stepY = Math.max(1, Math.floor(height / 50));

  function samplePixelAt(x, y) {
    const idx = (y * width + x) * 4;
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];
    const a = raw[idx + 3];
    if (a > 0) {
      samples.push([r, g, b]);
    }
  }

  // obere/untere Kante
  for (let x = 0; x < width; x += stepX) {
    samplePixelAt(x, 0);
    samplePixelAt(x, height - 1);
  }
  // linke/rechte Kante
  for (let y = 0; y < height; y += stepY) {
    samplePixelAt(0, y);
    samplePixelAt(width - 1, y);
  }

  if (samples.length === 0) {
    // nichts erkannt → Original zurück
    return inputBuffer;
  }

  // 2. Clustern
  const clusters = [];
  const maxClusterDist = 25; // Farbabstand

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
    if (!found) {
      clusters.push({ color: [...col], count: 1 });
    }
  }

  clusters.sort((a, b) => b.count - a.count);

  // NUR sehr helle Cluster als Hintergrund akzeptieren
  // → verhindert, dass „innere“ weiße Bereiche weggefressen werden.
  const bgColors = clusters
    .filter((c) => brightness(c.color) > 200) // hell genug
    .slice(0, 3)
    .map((c) => c.color);

  if (bgColors.length === 0) {
    // Kein klarer heller Hintergrund erkannt → Original zurück
    return inputBuffer;
  }

  // 3. Flood-Fill vom Rand
  const visited = new Uint8Array(width * height); // 0 = nicht besucht, 1 = Hintergrund
  const queue = [];
  const bgTolStart = 24; // eher streng am Rand
  const bgTolGrow = 28; // etwas großzügiger ins Innere

  function isBgColor(r, g, b, tol) {
    for (const bg of bgColors) {
      if (colorDist([r, g, b], bg) < tol) return true;
    }
    return false;
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

    // nur helle Hintergründe erlauben
    if (brightness([r, g, b]) > 200 && isBgColor(r, g, b, tol)) {
      visited[idxPix] = 1;
      queue.push([x, y]);
    }
  }

  // Startpunkte Rand
  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0, bgTolStart);
    tryEnqueue(x, height - 1, bgTolStart);
  }
  for (let y = 0; y < height; y++) {
    tryEnqueue(0, y, bgTolStart);
    tryEnqueue(width - 1, y, bgTolStart);
  }

  // BFS/DFS
  while (queue.length > 0) {
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
        (brightness([r, g, b]) > 200 && isBgColor(r, g, b, bgTolGrow))
      ) {
        visited[idxPix] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  // 4. Alle als Hintergrund markierten Pixel transparent machen
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idxPix = y * width + x;
      if (visited[idxPix]) {
        const idx = idxPix * 4;
        raw[idx + 3] = 0; // alpha = 0
      }
    }
  }

  const outBuffer = await sharp(raw, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  return outBuffer;
}

// --------------------------------------------------
// Generische Funktion: Artwork transparent + Mockup
// --------------------------------------------------
async function makePreviewWithBgRemoval(artworkUrl, mockupUrl, scale, offsetX, offsetY) {
  // Artwork laden
  const artRespBuf = await loadImage(artworkUrl);

  // Hintergrund entfernen – bei Fehler Original als PNG mit Alpha
  let transparentArt;
  try {
    transparentArt = await removeBackgroundFloodFill(artRespBuf);
  } catch (err) {
    console.error("BG-Removal Fehler, benutze Original:", err);
    transparentArt = await sharp(artRespBuf).ensureAlpha().png().toBuffer();
  }

  // Mockup laden
  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const mockMeta = await mockSharp.metadata();

  if (!mockMeta.width || !mockMeta.height) {
    throw new Error("Konnte Mockup-Größe nicht lesen.");
  }

  // Artwork skalieren
  const designBuf = await sharp(transparentArt)
    .resize(Math.round(mockMeta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const left = Math.round(mockMeta.width * offsetX);
  const top = Math.round(mockMeta.height * offsetY);

  const finalBuf = await mockSharp
    .composite([{ input: designBuf, left, top }])
    .png()
    .toBuffer();

  return finalBuf;
}

// --------------------------------------------------
// /tote-preview – Tasche mit freigestelltem Artwork
// --------------------------------------------------
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
    const finalBuffer = await makePreviewWithBgRemoval(
      artworkUrl,
      TOTE_MOCKUP_URL,
      0.42, // Größe auf Tasche
      0.26, // X-Offset
      0.46  // Y-Offset
    );

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    return res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------------------------------------
// /mug-preview – Tasse mit freigestelltem Artwork
// --------------------------------------------------
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
    const finalBuffer = await makePreviewWithBgRemoval(
      artworkUrl,
      MUG_MOCKUP_URL,
      0.325, // 25% größer als vorher (0.26 → 0.325)
      0.35,  // leicht angepasst, damit es trotz größer noch mittig sitzt
      0.37
    );

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /mug-preview:", err);
    return res.status(500).json({
      error: "Interner Fehler in /mug-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------------------------------------
// Serverstart
// --------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
