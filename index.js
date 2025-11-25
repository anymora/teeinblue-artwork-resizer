// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Tragetaschen-Mockup (Hintergrund)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Einfacher In-Memory-Cache: artworkUrl -> fertiges PNG
const previewCache = new Map(); // key: artworkUrl, value: Buffer

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (Flood-Fill Background Removal + Tragetasche) läuft.");
});

// --- Hilfsfunktionen ---

function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Entfernt Hintergrund per Flood-Fill:
 * - Randpixel werden gesampelt → dominante Hintergrundfarben ermittelt
 * - Von allen Randpixeln, die "hintergrundähnlich" sind, flood-fillen wir nach innen
 * - Nur Pixel, die mit dem Rand verbunden sind UND farblich zum Hintergrund passen, werden transparent
 * - Weiße/helle Bereiche, die NICHT an den Rand anschließen, bleiben erhalten
 */
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

  const clusters = [];
  const maxClusterDist = 25; // Farbabstand für Clusterbildung

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
  const bgColors = clusters.slice(0, 3).map(c => c.color);

  // 2. Flood-Fill vom Rand:
  //    - Startpunkte: Randpixel, die nah an einer bgColor sind
  //    - Wir markieren alle "Hintergrund-Pixel", die mit dem Rand zusammenhängen

  const visited = new Uint8Array(width * height); // 0 = nicht besucht, 1 = Hintergrund
  const queue = [];
  const bgTolStart = 28;  // etwas strenger für Starten
  const bgTolGrow = 32;   // etwas großzügiger beim Wachsen

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
      // schon transparent → als Hintergrund markieren
      visited[idxPix] = 1;
      queue.push([x, y]);
      return;
    }

    if (isBgColor(r, g, b, tol)) {
      visited[idxPix] = 1;
      queue.push([x, y]);
    }
  }

  // Startpunkte: Rand
  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0, bgTolStart);
    tryEnqueue(x, height - 1, bgTolStart);
  }
  for (let y = 0; y < height; y++) {
    tryEnqueue(0, y, bgTolStart);
    tryEnqueue(width - 1, y, bgTolStart);
  }

  // BFS/DFS über "Hintergrund"-Region
  while (queue.length > 0) {
    const [cx, cy] = queue.pop();

    // Nachbarn (4er-Konnektivität)
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

      if (a === 0 || isBgColor(r, g, b, bgTolGrow)) {
        visited[idxPix] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  // 3. Alle als Hintergrund markierten Pixel transparent machen
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

/**
 * GET /tote-preview?url=<URL_DES_ARTWORK-BILDES>
 *
 * Erwartet: JPG/PNG Artwork mit weißem oder Gitter-Hintergrund.
 * Ablauf:
 * 1. Artwork von der URL laden
 * 2. Hintergrund per Flood-Fill anhand der Randregion entfernen
 * 3. Tragetaschen-Mockup laden
 * 4. Artwork skalieren & positionieren
 * 5. Fertiges PNG zurück
 */
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res
      .status(400)
      .json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  // Cache-Hit? -> sofort zurück
  if (previewCache.has(artworkUrl)) {
    const cachedBuffer = previewCache.get(artworkUrl);
    res.setHeader("Content-Type", "image/png");
    return res.send(cachedBuffer);
  }

  try {
    // 1. Artwork laden
    const artResp = await fetch(artworkUrl);
    if (!artResp.ok) {
      return res.status(400).json({
        error: "Konnte Artwork-Bild nicht laden.",
        detail: `HTTP ${artResp.status}`,
      });
    }
    const artArrayBuf = await artResp.arrayBuffer();
    const artBuffer = Buffer.from(artArrayBuf);

    // 2. Hintergrund entfernen (Flood-Fill)
    let transparentArtBuffer;
    try {
      transparentArtBuffer = await removeBackgroundFloodFill(artBuffer);
    } catch (bgErr) {
      console.error("Fehler beim Background-Removal, verwende Original:", bgErr);
      transparentArtBuffer = await sharp(artBuffer).ensureAlpha().png().toBuffer();
    }

    // 3. Tragetaschen-Mockup laden
    const toteResp = await fetch(TOTE_MOCKUP_URL);
    if (!toteResp.ok) {
      return res.status(500).json({
        error: "Konnte Tragetaschen-Mockup nicht laden.",
        detail: `HTTP ${toteResp.status}`,
      });
    }
    const toteArrayBuf = await toteResp.arrayBuffer();
    const toteBuffer = Buffer.from(toteArrayBuf);

    const toteSharp = sharp(toteBuffer);
    const toteMeta = await toteSharp.metadata();

    if (!toteMeta.width || !toteMeta.height) {
      return res
        .status(500)
        .json({ error: "Konnte Größe des Tragetaschen-Mockups nicht lesen." });
    }

    // 4. Artwork skalieren (Breite ~45% der Tasche)
    const designOnToteBuffer = await sharp(transparentArtBuffer)
      .resize(Math.round(toteMeta.width * 0.45), null, {
        fit: "inside",
        fastShrinkOnLoad: true,
      })
      .png()
      .toBuffer();

    // Position auf der Tasche (wie gehabt)
    const offsetLeft = Math.round(toteMeta.width * 0.26);
    const offsetTop = Math.round(toteMeta.height * 0.36);

    const finalBuffer = await toteSharp
      .composite([
        {
          input: designOnToteBuffer,
          left: offsetLeft,
          top: offsetTop,
        },
      ])
      .png()
      .toBuffer();

    // 5. Cache
    previewCache.set(artworkUrl, finalBuffer);

    // 6. Antwort
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

// Server starten
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
