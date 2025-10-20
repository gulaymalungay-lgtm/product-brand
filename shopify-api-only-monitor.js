import express from "express";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import fs from "fs";

const app = express();
app.use(express.json());

// ---------------- CONFIG ----------------
const SHOPIFY_STORE = "https://tpt-test1.myshopify.com";
const ACCESS_TOKEN = "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";

const EMAIL_TO = "jvoorhees109@gmail.com";
const EMAIL_FROM = "jvoorhees109@gmail.com"; // Gmail
const EMAIL_PASS = "lvhw jebp lrkx rmbi";   // Gmail app password

const STATE_FILE = "vendor-state.json"; // keeps track to avoid spam

// ---------------- EMAIL SETUP ----------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_FROM,
    pass: EMAIL_PASS
  }
});

// ---------------- HELPERS ----------------
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Fetch all products (with pagination)
async function getAllProducts() {
  let allProducts = [];
  let pageInfo = null;
  let hasNext = true;

  while (hasNext) {
    let url = `https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250`;
    if (pageInfo) url += `&page_info=${pageInfo}`;

    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    allProducts = allProducts.concat(data.products);

    const linkHeader = res.headers.get("Link");
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<[^>]*page_info=([^>]+)>; rel="next"/);
      pageInfo = match ? match[1] : null;
      hasNext = !!pageInfo;
    } else hasNext = false;
  }

  return allProducts;
}

// Send email
async function sendEmail(subject, message) {
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: message,
    html: `<pre>${message}</pre>`
  });
  console.log(`✅ Email sent: ${subject}`);
}

// ---------------- MAIN FUNCTION ----------------
async function checkBrandsStock() {
  console.log("\n=== Checking all brands ===", new Date().toLocaleString());
  const products = await getAllProducts();
  const state = loadState();
  const newState = {};

  // Group products by vendor
  const vendors = {};
  for (const p of products) {
    if (!vendors[p.vendor]) vendors[p.vendor] = [];
    vendors[p.vendor].push(p);
  }

  // Check stock per vendor
  for (const [vendor, products] of Object.entries(vendors)) {
    const allOOS = products.every(prod =>
      prod.variants.every(v => v.inventory_quantity <= 0)
    );

    newState[vendor] = allOOS ? "OOS" : "IN_STOCK";

    // Only send email if state changed
    if (allOOS && state[vendor] !== "OOS") {
      await sendEmail(
        `🚨 ALL ${vendor} Products OUT OF STOCK`,
        `All products under the brand "${vendor}" are now out of stock.\n\n` +
        `⚠️ Action Required: Hide this brand on your brand page.`
      );
    } else if (!allOOS && state[vendor] === "OOS") {
      await sendEmail(
        `✅ ${vendor} Products BACK IN STOCK`,
        `Some products under the brand "${vendor}" are back in stock.\n\n` +
        `✅ Action Required: Show this brand on your brand page.`
      );
    }
  }

  saveState(newState);
  console.log("=== Brand check complete ===\n");
}

// ---------------- ENDPOINTS ----------------
app.get("/check-now", async (req, res) => {
  try {
    await checkBrandsStock();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
