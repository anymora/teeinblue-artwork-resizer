// index.js
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import sharp from "sharp";

const app = express();

// remove.bg API-Key aus Railway-ENV
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;

// Tragetaschen-Mockup (Hintergrund)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Einfacher In-Memory-Cache: artworkUrl -> fertiges PNG
const previewCache = new Map(); // key: artworkUrl, value: Buffer

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (remove.bg Version) läuft.");
});

/**
 * Debug-Route: testet nur remove.bg-Konnektivität
 * GET /test-removebg?url=<IMAGE_URL>
 */
app.get("/test-removebg", async (req, res) => {
  try {
    if (!REMOVE_BG_API_KEY) {
      return res.status(500).json({ error: "REMOVE_BG_API_KEY ist nicht gesetzt." });
    }

    const testUrl = req.query.url;
    if (!testUrl) {
      return res
        .status(400)
        .json({ error: "Bitte ?url=<IMAGE_URL> angeben, um remove.bg zu testen." });
    }

    const formData = new FormData();
    formData.append("image_url", testUrl);
    formData.append("size", "auto");
    formData.append("type", "product"); // Hinweis an remove.bg: Produkt-Motiv im Fokus

    const r = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: {
        "X-Api-Key": REMOVE_BG_API_KEY
      },
      body: formData
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("remove.bg Fehler:", r.status, txt);
      return res.status(500).json({
        error: "remove.bg Request fehlgeschlagen",
        status: r.status,
        body: txt
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  } catch (err) {
    console.error("Fehler in /test-removebg:", err);
    res.status(500).json({ error: "Interner Fehler in /test-removebg", detail: String(err.message || err) });
  }
});

/**
 * GET /tote-preview?url=<URL_DES_ARTWORK-BILDES>
 *
 * Erwartet: Ein Bild, bei dem das Design im Vordergrund steht (z.B. 2. Produktbild / Artwork),
 * remove.bg entfernt den Hintergrund → wir legen das Motiv auf die Tragetasche.
 */
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res
      .status(400)
      .json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  if (!REMOVE_BG_API_KEY) {
    return res.status(500).json({ error: "REMOVE_BG_API_KEY ist nicht gesetzt." });
  }

  // 0. Cache-Hit? -> sofort zurück (zweiter Aufruf für dasselbe Design ist dann sofort)
  if (previewCache.has(artworkUrl)) {
    const cachedBuffer = previewCache.get(artworkUrl);
    res.setHeader("Content-Type", "image/png");
    return res.send(cachedBuffer);
  }

  try {
    // 1. remove.bg aufrufen, um Hintergrund aus dem Artwork zu entfernen
    const formData = new FormData();
    formData.append("image_url", artworkUrl);
    formData.append("size", "auto");     // beste Qualität automatisch
    formData.append("type", "product");  // sagt remove.bg: es ist ein Produkt, nicht Person

    const rbgResp = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: {
        "X-Api-Key": REMOVE_BG_API_KEY
      },
      body: formData
    });

    if (!rbgResp.ok) {
      const txt = await rbgResp.text();
      console.error("remove.bg Fehler:", rbgResp.status, txt);
      return res.status(500).json({
        error: "remove.bg Request fehlgeschlagen",
        status: rbgResp.status,
        body: txt
      });
    }

    const noBgArrayBuf = await rbgResp.arrayBuffer();
    let designPngBuffer = Buffer.from(noBgArrayBuf);

    // Sicherheit: PNG + Alphakanal
    designPngBuffer = await sharp(designPngBuffer)
      .ensureAlpha()
      .png()
      .toBuffer();

    // 2. Tragetaschen-Mockup laden
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

    // 3. Design skalieren (Breite ~45% der Tasche)
    const designOnToteBuffer = await sharp(designPngBuffer)
      .resize(Math.round(toteMeta.width * 0.45), null, {
        fit: "inside",
        fastShrinkOnLoad: true
      })
      .png()
      .toBuffer();

    // 4. Position auf der Tasche:
    // - etwas weiter nach links (0.26)
    // - etwas weiter nach unten (0.36)
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

    // 5. In Cache legen (für zukünftige Aufrufe mit gleicher URL)
    previewCache.set(artworkUrl, finalBuffer);

    // 6. Fertiges Bild zurückgeben
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview (gesamt):", err);
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
