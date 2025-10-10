// import dependencies
const express = require("express");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const fs = require("fs-extra");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const https = require("https");
const http = require("http");

// load env variables
const STRIPE_SECRET_KEY =
  process.env.PROD === "True"
    ? process.env.PROD_STRIPE_SECRET_KEY
    : process.env.TEST_STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET =
  process.env.PROD === "True"
    ? process.env.PROD_STRIPE_WEBHOOK_SECRET
    : process.env.TEST_STRIPE_WEBHOOK_SECRET;

// init app
const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// SSL Certificate paths (update with your win-acme PEM folder)
const sslOptions = {
  key: fs.readFileSync("C:/tools/frustrationcourtserwer.com-key.pem"),
  cert: fs.readFileSync("C:/tools/frustrationcourtserwer.com-fullchain.pem"),
  minVersion: "TLSv1.2",        // recommended
  honorCipherOrder: true
};


// SQLite setup
const dbPath = path.join(__dirname, "verdict_images.db");
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`
  CREATE TABLE IF NOT EXISTS images (
    item_id TEXT PRIMARY KEY,
    case_details TEXT,
    verdict TEXT,
    image_url TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
  `);
});

// Use JSON for all routes EXCEPT /webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  express.json()(req, res, next);
});

// Log every request for debugging
app.use("/static", (req, res, next) => {
  console.log(`[STATIC] Incoming request: ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Serve static folder with explicit options
app.use(
  "/static",
  express.static(path.join(__dirname, "public", "images"), {
    dotfiles: "ignore",
    index: false,
    maxAge: "1d",
    redirect: false,
  })
);
// ---- helper: increment credits ----
async function incrementCredits(subscriberId, credit) {
  const resp = await fetch(
    `https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  const data = await resp.json();
  const subscriber = data?.data;

  if (!subscriber) {
    console.log(`Subscriber ${subscriberId} not found`);
    return;
  }

  let currentCredits =
    subscriber.custom_fields?.find((f) => f.name === "credits")?.value ?? 0;
  currentCredits = Number(currentCredits) || 0;

  const newCredits = currentCredits + Number(credit);

  const setResp = await fetch(
    "https://api.manychat.com/fb/subscriber/setCustomField",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        field_id: 12880026,
        field_name: "credits",
        field_value: newCredits,
      }),
    }
  );

  const setData = await setResp.json();
  console.log("Set credits response:", subscriberId, JSON.stringify(setData));
  console.log(`Credits updated from ${currentCredits} → ${newCredits}`);
  return newCredits;
}

// ---- endpoint: create checkout session ----
app.post("/create-checkout-session", express.json(), async (req, res) => {
  const {
    client_reference_id,
    sue_reason,
    answer_1,
    answer_2,
    answer_3,
    answer_4,
    credit,
  } = req.body;

  let product_data, amount;
  if (credit === "1") {
    product_data = "One Credit Purchase"; // $3.00
    amount = 300;
  } else if (credit === "3") {
    product_data = "Three Credits Purchase"; // $7.99
    amount = 799;
  } else if (credit === "5") {
    product_data = "Five Credits Purchase"; // $12.00
    amount = 1200;
  } else {
    return res.status(400).json({ error: "Invalid credit option" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: product_data },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      payment_intent_data: {
        metadata: {
          client_reference_id: String(client_reference_id || ""),
          sue_reason: String(sue_reason || ""),
          credit_amount: String(credit || ""),
          answer_1: String(answer_1 || ""),
          answer_2: String(answer_2 || ""),
          answer_3: String(answer_3 || ""),
          answer_4: String(answer_4 || ""),
        },
      },
      client_reference_id: String(client_reference_id || ""),
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error", err);
    return res.status(500).json({ error: err.message });
  }
});

// Success callback
app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  res.send(`
  <!DOCTYPE html>
  <html>
    <head>
    <title>Payment Success</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f9f9f9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
      h1 { font-size: 28px; color: #2d7a46; }
      p { font-size: 18px; color: #555; }
    </style>
    </head>
    <body>
    <div class="card">
      <h1>🎉 Payment Created!</h1>
      <p>Thank you for your purchase.</p>
      <p><strong>Session ID:</strong> ${session.id}</p>
      <p>You will be informed via Frustration Court.</p>
    </div>
    </body>
  </html>
  `);
});

// Cancel callback
app.get("/cancel", (req, res) => {
  console.log("User canceled payment");
  res.send(`
  <!DOCTYPE html>
  <html>
    <head>
    <title>Payment Canceled</title>
    <style>
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #fff5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
      h1 { font-size: 28px; color: #d93025; }
      p { font-size: 18px; color: #444; }
    </style>
    </head>
    <body>
    <div class="card">
      <h1>❌ Payment Canceled</h1>
      <p>Your transaction has been canceled. No charges were made.</p>
    </div>
    </body>
  </html>
  `);
});

// ---- Stripe webhook endpoint ----
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.json({ received: true });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const manychatId = session.client_reference_id;
      const paymentIntent = await stripe.paymentIntents.retrieve(
        session.payment_intent
      );
      const credit = paymentIntent.metadata.credit_amount;

      if (manychatId) {
        const newCredits = await incrementCredits(manychatId, credit);

        const sendPayload = {
          subscriber_id: Number(manychatId),
          data: {
            version: "v2",
            content: [
              {
                type: "text",
                text: `✅ Payment received! Your new credits: ${newCredits}`,
              },
            ],
          },
        };

        const resp = await fetch(
          "https://api.manychat.com/fb/sending/sendContent",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(sendPayload),
          }
        );

        const respText = await resp.text();
        console.log(
          "📨 ManyChat sendFlow response:",
          manychatId,
          resp.status,
          respText,
          event.type
        );
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const session = event.data.object;
      const manychatId = session.metadata.client_reference_id;
      const sendPayload = {
        subscriber_id: Number(manychatId),
        data: {
          version: "v2",
          content: [
            {
              type: "text",
              text: "⚠️ Payment failed! Try to use another card.",
            },
          ],
        },
      };

      const resp = await fetch(
        "https://api.manychat.com/fb/sending/sendContent",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(sendPayload),
        }
      );

      const respText = await resp.text();
      console.log(
        "📨 ManyChat sendFlow response for Payment failed:",
        manychatId,
        resp.status,
        respText,
        event.type
      );
    }
  }
);

// ---- endpoint: get funny verdict ----
app.post("/get-funny-verdict", async (req, res) => {
  const { verdict_item_id } = req.body;
  console.log("✅ Received get-funny-verdict request:", verdict_item_id);

  if (!verdict_item_id)
    return res.status(400).json({ error: "Missing verdict_item_id" });

  db.get(`SELECT verdict FROM images WHERE item_id = ?`, [verdict_item_id], (err, row) => {
    if (err) {
      console.error("DB query error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (!row) return res.status(404).json({ error: "Verdict not found" });
    return res.json({ funny_verdict: row.verdict });
  });
});


// ---- endpoint: generate funny verdict ----
app.post("/generate-verdict", async (req, res) => {
  console.log("✅ Received generate-verdict request:", req.body);

  const { case_details, answer_1, answer_2, answer_3, answer_4 } = req.body;
  if (!case_details || !answer_1 || !answer_2 || !answer_3 || !answer_4)
    return res.status(400).json({ error: "Missing required fields" });

  const item_id = uuidv4();

  db.run(
    `INSERT OR REPLACE INTO images (item_id, case_details, verdict, status) VALUES (?, ?, ?, ?)`,
    [item_id, case_details, "", "processing"]
  );

  // Return immediately while processing verdict asynchronously
  res.json({ verdict_item_id: item_id });

  setImmediate(async () => {
    try {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

      const prompt = `
You are the sarcastic AI Judge of the "Frustration Court" — an imaginary courtroom where petty complaints and emotional meltdowns are judged with humor, irony, and emojis.

You must create a short, funny, and slightly dramatic verdict (2–4 sentences) based on the following inputs:

CASE DETAILS: "${case_details}"

Question 1: Who’s standing before the Court today? (Victim/Hero/Angry Soul) → "${answer_1}"
Question 2: Who or what do they want to sue? → "${answer_2}"
Question 3: Anger level (1–10) → "${answer_3}"
Question 4: Are they innocent or a little guilty too? → "${answer_4}"

Rules:
- Be sarcastic but kind.
- Always end with a fitting emoji combo that matches the emotion.
- Avoid real names, offensive content, or politics.
- Write as if spoken by a dramatic, overworked judge with a sense of humor.
- Example verdicts:
  - "Verdict: You are found guilty of excessive drama. Sentence: One deep breath and a cookie. 🍪⚖️"
  - "The Court finds you 80% innocent, 20% dramatic. Case closed with laughter. 😂🔨"
  - "Justice served — with extra sarcasm. Please collect your emotional refund at the exit. 💸🤪"

Output only the final funny verdict (1 paragraph).
`;

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are the sarcastic AI judge of Frustration Court." },
            { role: "user", content: prompt },
          ],
          temperature: 0.9,
          max_tokens: 200,
        }),
      });

      const data = await response.json();
      const funnyVerdict =
        data.choices?.[0]?.message?.content?.trim() ||
        "The Court is still laughing. Please retry later. 🤖⚖️";
      console.log(`Generated verdict ${funnyVerdict}`);

      db.run(
        `UPDATE images SET verdict = ?, status = ? WHERE item_id = ?`,
        [funnyVerdict, "completed", item_id],
        (err) => {
          if (err) console.error("DB update error:", err);
          else console.log(`✅ Verdict stored for item_id ${item_id}`);
        }
      );
    } catch (err) {
      console.error("❌ Error generating verdict:", err);
      db.run(`UPDATE images SET status = ? WHERE item_id = ?`, ["failed", item_id]);
    }
  });
});


// ---- endpoint: async OpenAI image generation with SQLite ----
app.post("/generate-verdict-image", async (req, res) => {
  console.log("✅ Received image generation request:", req.body);
  const { case_details, verdict, answer_3 } = req.body;

  if (!case_details || !verdict )
    return res.status(400).json({ error: "Missing case_details, verdict" });

  const item_id = uuidv4();
  db.run(
    `INSERT OR REPLACE INTO images (item_id, case_details, verdict, status) VALUES (?, ?, ?, ?)`,
    [item_id, case_details, verdict, "processing"]
  );

  res.json({ status: "processing", item_id });
  
  const score = Number(answer_3);

  let mood = "";

  if (score >= 1 && score <= 3) {
    mood = "angry";
  } else if (score >= 4 && score <= 6) {
    mood = "sad";
  } else if (score >= 7 && score <= 8) {
    mood = "ironic";
  } else if (score >= 9 && score <= 10) {
    mood = "absurd";
  } else {
    mood = "unknown"; // fallback for out-of-range values
  }
  const verdict_title = verdict;
  setImmediate(async () => {
    try {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      const prompt = `Create a vertical poster for the fictional “Frustration Court”. Goal: a shareable verdict image that mixes dark humor with symbolic justice.\n\nCONTENT & COMPOSITION\n- Show a surreal, stylized courtroom led by an AI Judge (abstract/robotic, no real person likeness).\n- Central “verdict panel” (parchment or hologram) framed by subtle chaos: broken gavel motion blur, floating papers, cracked scales.\n- Add a small red wax seal or stamp that reads exactly: “Frustration Court”.\n- Include one or two subtle SYMBOLS that hint at the case: ${case_details} (e.g., if it’s about deadlines, show a distorted clock; if it’s about an ex, a cracked heart-as-evidence).\n- Leave clean space inside the verdict panel for overlay text later. Do NOT place long readable text inside the image.\n- If a SHORT headline is provided (${verdict_title} ≤ 6 words), you may render ONLY that as a bold stamped title on the panel. Otherwise use decorative lines or fake scribbles as placeholders.\n\nMOOD & STYLE\n- Tone: ${mood} (angry / sad / ironic / absurd). Reflect it in color and lighting.\n- Style: cinematic concept art with a graphic, poster-like finish; slightly stylized (not photo-real).\n- Palette guidance:\n - angry → deep blacks, crimson reds, steel gray;\n - sad → charcoal grays, muted blues, parchment highlights;\n - ironic/absurd → darker base with playful crimson/gold accents.\n- Lighting: spotlight on the verdict panel, soft red rim light, subtle volumetric shadows.\n- Texture: aged paper grain, faint light leaks, minimal vignette.\n\nRULES & SAFETY\n- No gore, no violence, no political or religious symbols, no real logos (besides “Frustration Court”).\n- No long readable body text; only a small headline if ${verdict_title} is present.\n- Keep it clean, sharp, and social-media-ready.\n\nOUTPUT\n- Vertical composition optimized for mobile sharing.\n- Deliver a single, polished poster of the described scene. verdict: ${verdict}`;

      const response = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt,
            size: "1024x1792",
          }),
        }
      );

      const data = await response.json();
      if (!data.data || !data.data[0]?.url) {
        console.error("OpenAI image API failed:", data);
        db.run(`UPDATE images SET status = ? WHERE item_id = ?`, [
          "failed",
          item_id,
        ]);
        return;
      }

      const imageUrl = data.data[0].url;
      console.log("✅ OpenAI image URL:", imageUrl);
      // Download image into /public/images folder
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      const localImageName = `${item_id}.png`;
      const localImagePath = path.join(
        __dirname,
        "public",
        "images",
        localImageName
      );

      await fs.outputFile(localImagePath, Buffer.from(imageBuffer));
      const publicImageUrl = `${process.env.BASE_URL}/static/${localImageName}`;
      db.run(`UPDATE images SET image_url = ?, status = ? WHERE item_id = ?`, [
        publicImageUrl,
        "completed",
        item_id,
      ]);
    } catch (err) {
      console.error("❌ Error generating image:", err);
      db.run(`UPDATE images SET status = ? WHERE item_id = ?`, [
        "failed",
        item_id,
      ]);
    }
  });
});

// ---- endpoint: retrieve image URL ----
app.post("/get-image-url", async (req, res) => {
  const { item_id } = req.body;
  console.log("✅ Received get-image-url request:", item_id);
  if (!item_id) return res.status(400).json({ error: "Missing item_id" });

  db.get(`SELECT * FROM images WHERE item_id = ?`, [item_id], (err, row) => {
    if (err) {
      console.error("DB query error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (!row) return res.status(404).json({ error: "Item not found" });
    return res.json({
      image_url: row.image_url,
      item_id: row.item_id,
      status: row.status,
    });
  });
});

// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---- START HTTPS SERVER ----
https.createServer(sslOptions, app).listen(443, () => {
  console.log("✅ HTTPS server running at https://frustrationcourtserwer.com");
});

// ---- Optional HTTP -> HTTPS redirect ----
http
  .createServer((req, res) => {
    res.writeHead(301, { Location: "https://" + req.headers.host + req.url });
    res.end();
  })
  .listen(80);
