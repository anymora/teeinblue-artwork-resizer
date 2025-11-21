import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import OpenAI from "openai";

const app = express();

// OpenAI Client – API-Key kommt aus Railway Variable OPENAI_API_KEY
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Fixe Tragetaschen-Vorlage
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Kleine Helper-Funktion zum Laden von Bildern als Buffer
async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} – Status ${res.status}`);
  }
  const arrBuf = await res.arrayBuffer();
  return Buffer.from(arrBuf);
}

/**
 * GET /tote-preview?url=<URL_DES_CUSTOMIZATION_IMAGE>
 *
 * 1) Lädt das Kissen-Mockup (TeeInBlue _customization_image)
 * 2) Lässt GPT-Image-1 das reine Design als transparente PNG extrahieren
 * 3) Legt das extrahierte Design auf die Tragetasche
 * 4) Gibt das fertige Vorschaubild als PNG zurück
 */
app.get("/tote-preview", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Parameter ?url fehlt" });
  }

  try {
    // 1) Original-Kissen-Mockup laden
    const cushionBuffer = await downloadImage(url);

    // 2) Design mit GPT-Image-1 aus dem Mockup extrahieren
    //    WICHTIG: Buffer muss einen Dateinamen bekommen, sonst weiß die Lib nicht, dass es ein PNG/JPG ist
    const cushionFile = Buffer.from(cushionBuffer);
    cushionFile.name = "cushion_mockup.jpg";

    const aiResponse = await client.images.edit({
      model: "gpt-image-1",
      // gpt-image-1 akzeptiert ein oder mehrere Bilder – wir geben hier eins
      image: [cushionFile],
      prompt:
        "Das Design befindet sich auf einem Mockup (z.B. Kissen). "
        + "Extrahiere exakt dieses Design ohne es zu verändern aus dem Mockup, "
        + "entferne den Hintergrund und alle Mockup-Elemente "
        + "und gib nur das Design mit transparentem Hintergrund als PNG zurück.",
      size: "1024x1024",
      n: 1,
      response_format: "b64_json"
    });

    const designB64 = aiResponse.data[0].b64_json;
    const designPngBuffer = Buffer.from(designB64, "base64");

    // 3) Tragetaschen-Mockup laden
    const toteBuffer = await downloadImage(TOTE_MOCKUP_URL);

    // 4) Design auf Tragetasche legen
    //    Hier kannst du Größe & Position der Artwork-Vorschau fein-tunen
    const resizedDesignBuffer = await sharp(designPngBuffer)
      .resize({
        width: 700,       // Breite des Designs auf der Tragetasche
        fit: "contain",
      })
      .png()
      .toBuffer();

    const finalBuffer = await sharp(toteBuffer)
      .composite([
        {
          input: resizedDesignBuffer,
          // leicht nach unten und leicht nach links versetzt
          left: 220,      // X-Offset
          top: 260        // Y-Offset
        }
      ])
      .png()
      .toBuffer();

    // 5) PNG direkt zurückgeben
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
