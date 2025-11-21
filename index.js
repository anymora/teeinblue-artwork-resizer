// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import OpenAI, { toFile } from "openai";

const app = express();

// OpenAI-Client, liest deinen Key aus Railway-ENV OPENAI_API_KEY
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Tote-Mockup (Hintergrund) – dein Shopify-Bild
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer läuft.");
});

/**
 * Debug-Route: prüft NUR, ob der Server OpenAI überhaupt erreicht.
 * GET /test-openai
 */
app.get("/test-openai", async (req, res) => {
  try {
    const models = await openai.images.generate({
      model: "gpt-image-1",
      prompt: "test",
      size: "256x256",
    });

    res.json({
      ok: true,
      info: "OpenAI erreichbar",
      type: typeof models,
    });
  } catch (err) {
    console.error("Fehler in /test-openai:", {
      message: err.message,
      name: err.name,
      code: err.code,
      status: err.status,
      response: err.response?.data,
    });

    res.status(500).json({
      error: "Fehler in /test-openai",
      message: err.message,
      name: err.name,
      code: err.code,
      status: err.status,
    });
  }
});

/**
 * GET /tote-preview?url=<URL_DES_KISSEN_MOCKUPS>
 */
app.get("/tote-preview", async (req, res) => {
  const sourceUrl = req.query.url;

  if (!sourceUrl || typeof sourceUrl !== "string") {
    return res
      .status(400)
      .json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  try {
    // 1. Mockup vom Kunden (z.B. Kopfkissen) laden
    const srcResp = await fetch(sourceUrl);
    if (!srcResp.ok) {
      return res.status(400).json({
        error: "Konnte Quellbild nicht laden.",
        detail: `HTTP ${srcResp.status}`,
      });
    }
    const srcArrayBuf = await srcResp.arrayBuffer();
    const srcBuffer = Buffer.from(srcArrayBuf);

    // 2. In quadratisches PNG bringen – etwas kleinere Auflösung (768) für mehr Speed
    const WORK_SIZE = 768;

    const squarePngBuffer = await sharp(srcBuffer)
      .resize(WORK_SIZE, WORK_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // File-Objekt für OpenAI bauen
    const imageFile = await toFile(squarePngBuffer, "mockup.png", {
      type: "image/png",
    });

    // 3. OpenAI: Design aus dem Mockup freistellen – mit TRANSPARENTEM Hintergrund
    let editResult;
    try {
      editResult = await openai.images.edit({
        model: "gpt-image-1",
        image: imageFile,
        prompt:
          "Das Bild zeigt ein Produkt-Mockup mit einem Druckmotiv auf einem Kissen. " +
          "Extrahiere NUR das eigentliche Druckmotiv (Design) inklusive seiner jetzigen grafischen Elemente " +
          "(Hintergrundfarbe, Brush-Rand, Text, Herzen etc.). " +
          "ALLES, was aktuell Kissen, Sofa, Wand, Umgebung oder zusätzliche weiße Fläche ist, " +
          "muss komplett TRANSPARENT werden. " +
          "Das Ergebnis muss ein PNG mit Alphakanal sein, ohne zusätzliche weiße oder farbige Hintergründe. " +
          "Es darf KEIN neuer weißer Rahmen oder Hintergrund hinzugefügt werden.",
        size: `${WORK_SIZE}x${WORK_SIZE}`, // 768x768 für etwas mehr Speed
      });
    } catch (err) {
      console.error("OpenAI-Fehler in /tote-preview:", {
        message: err.message,
        name: err.name,
        code: err.code,
        status: err.status,
        response: err.response?.data,
      });

      return res.status(500).json({
        error: "OpenAI-Fehler in /tote-preview",
        message: err.message,
        code: err.code,
        status: err.status,
      });
    }

    const designB64 = editResult.data[0].b64_json;
    if (!designB64) {
      return res
        .status(500)
        .json({ error: "OpenAI hat kein Bild zurückgegeben." });
    }
    const designPngBuffer = Buffer.from(designB64, "base64");

    // 4. Tragetaschen-Mockup laden
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

    // Design skalieren (Breite ~45% der Tasche)
    const designOnToteBuffer = await sharp(designPngBuffer)
      .resize(Math.round(toteMeta.width * 0.45))
      .png()
      .toBuffer();

    // Position auf der Tasche:
    // - etwas weiter nach links => Faktor von 0.28 -> 0.26 reduziert
    // - deutlich weiter nach unten => Faktor von 0.32 -> 0.36 erhöht
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

    // 5. Fertiges Bild zurückgeben
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
