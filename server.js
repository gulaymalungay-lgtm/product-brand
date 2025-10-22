const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const app = express();

// CRITICAL FIX: Save raw body as Buffer (not string) for HMAC verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // Save as Buffer, not string!
  },
  strict: false,
  type: ['application/json', 'text/plain']
}));

// Fallback for empty bodies
app.use((req, res, next) => {
  if (!req.body || (typeof req.body === 'object' && Object.keys(req.body).length === 0)) {
    req.body = {};
  }
  next();
});

// Configuration from environment variables
const CONFIG = {
  SHOPIFY_SHOP: process.env.SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  BRANDS_TO_MONITOR: process.env.BRANDS_TO_MONITOR ? 
    process.env.BRANDS_TO_MONITOR.split(',').map(b => b.trim()) : [],
  // Optional: Use SendGrid API key instead of SMTP
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || null
};

// Validate configuration on startup
const requiredVars = [
  'SHOPIFY_SHOP', 
  'SHOPIFY_ACCESS_TOKEN', 
  'SHOPIFY_WEBHOOK_SECRET',
  'EMAIL_FROM',
  'EMAIL_TO',
  'BRANDS_TO_MONITOR'
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

console.log('✅ Configuration loaded successfully');
console.log(`📦 Monitoring ${CONFIG.BRANDS_TO_MONITOR.length} brands:`, CONFIG.BRANDS_TO_MONITOR);
console.log(`📧 Email config: FROM=${CONFIG.EMAIL_FROM} TO=${CONFIG.EMAIL_TO}`);

// Email setup - Choose method based on available credentials
let transporter;
let emailMethod = 'none';

if (CONFIG.SENDGRID_API_KEY) {
  // Use SendGrid API (recommended for production)
  emailMethod = 'sendgrid';
  console.log('📧 Using SendGrid API for emails');
} else if (CONFIG.EMAIL_PASSWORD) {
  // Use Gmail SMTP
  emailMethod = 'smtp';
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: CONFIG.EMAIL_FROM,
      pass: CONFIG.EMAIL_PASSWORD
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
  console.log('📧 Using Gmail SMTP for emails');
  
  // Verify SMTP connection
  transporter.verify(function(error, success) {
    if (error) {
      console.error('❌ SMTP connection failed:', error.message);
      console.error('⚠️  Consider using SendGrid instead - add SENDGRID_API_KEY to env vars');
    } else {
      console.log('✅ SMTP server is ready to send messages');
    }
  });
}

// Track last notification state to avoid spam
const lastNotificationState = {};

// Verify webhook authenticity - CRITICAL FIX
function verifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac) {
    console.log('⚠️  No HMAC header found');
    return false;
  }
  
  if (!req.rawBody) {
    console.log('⚠️  No raw body available for verification');
    return false;
  }
  
  const generatedHash = crypto
    .createHmac('sha256', CONFIG.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody) // Use Buffer directly, don't convert to string
    .digest('base64');

  console.log('🔐 HMAC Verification:');
  console.log('   Shopify HMAC:', hmac);
  console.log('   Generated HMAC:', generatedHash);
  console.log('   Match:', generatedHash === hmac);

  // timingSafeEqual avoids timing attacks (recommended)
  try {
    return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmac));
  } catch (err) {
    console.log('❌ timingSafeEqual failed:', err.message);
    return false;
  }
}

// Fetch all products for a brand (handles pagination)
async function getProductsForBrand(vendor) {
  let allProducts = [];
  let url = `${CONFIG.SHOPIFY_SHOP}/admin/api/2024-10/products.json?vendor=${encodeURIComponent(vendor)}&limit=250`;
  
  while (url) {
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    allProducts = allProducts.concat(data.products || []);
    
    // Check for pagination
    const linkHeader = response.headers.get('Link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }
  }
  
  return allProducts;
}

// Check if all products in brand are OOS
async function checkBrandStock(vendor) {
  const products = await getProductsForBrand(vendor);
  
  if (products.length === 0) {
    return { 
      allOOS: false, 
      totalProducts: 0, 
      oosProducts: 0,
      inStockProducts: 0
    };
  }
  
  let totalProducts = products.length;
  let oosProducts = 0;
  
  for (const product of products) {
    let productTotalStock = 0;
    
    for (const variant of product.variants) {
      productTotalStock += variant.inventory_quantity || 0;
    }
    
    if (productTotalStock <= 0) {
      oosProducts++;
    }
  }
  
  return {
    allOOS: totalProducts === oosProducts,
    totalProducts,
    oosProducts,
    inStockProducts: totalProducts - oosProducts
  };
}

// Send email via SendGrid API
async function sendEmailViaSendGrid(subject, message) {
  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: CONFIG.EMAIL_TO }]
        }],
        from: { email: CONFIG.EMAIL_FROM },
        subject: subject,
        content: [{
          type: 'text/plain',
          value: message
        }]
      })
    });
    
    if (response.ok) {
      console.log('✅ Email sent via SendGrid:', subject);
      return { success: true, method: 'sendgrid' };
    } else {
      const error = await response.text();
      console.error('❌ SendGrid error:', error);
      return { success: false, error: error };
    }
  } catch (error) {
    console.error('❌ SendGrid request failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Send email via SMTP with timeout
async function sendEmailViaSMTP(subject, message) {
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Email send timeout after 15 seconds')), 15000)
    );
    
    const sendPromise = transporter.sendMail({
      from: CONFIG.EMAIL_FROM,
      to: CONFIG.EMAIL_TO,
      subject: subject,
      text: message,
      html: `<div style="font-family: monospace; white-space: pre-wrap;">${message}</div>`
    });
    
    const info = await Promise.race([sendPromise, timeoutPromise]);
    console.log('✅ Email sent via SMTP:', subject);
    console.log('📧 Message ID:', info.messageId);
    return { success: true, messageId: info.messageId, method: 'smtp' };
  } catch (error) {
    console.error('❌ SMTP error:', error.code, error.message);
    return { success: false, error: error.message, code: error.code };
  }
}

// Send email notification (auto-select method)
async function sendEmail(subject, message) {
  if (emailMethod === 'sendgrid') {
    return await sendEmailViaSendGrid(subject, message);
  } else if (emailMethod === 'smtp') {
    return await sendEmailViaSMTP(subject, message);
  } else {
    console.error('❌ No email method configured');
    return { success: false, error: 'No email credentials configured' };
  }
}

// Main webhook handler - FIXED VERSION
app.post('/webhook/inventory', async (req, res) => {
  console.log('📥 Webhook received');
  console.log('📋 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('📦 Body type:', typeof req.body);
  console.log('📦 Raw body length:', req.rawBody?.length || 0);
  
  // Verify webhook is from Shopify
  if (!verifyWebhook(req)) {
    console.log('❌ Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }
  
  console.log('✅ Webhook verified');
  
  // Handle test webhooks (they often have empty bodies)
  if (!req.body || Object.keys(req.body).length === 0) {
    console.log('⚠️  Empty webhook body (likely a test webhook)');
    console.log('✅ Test webhook received successfully');
    return res.status(200).send('OK - Test webhook received');
  }
  
  console.log('📄 Webhook body:', JSON.stringify(req.body, null, 2));
  
  // Respond immediately to Shopify
  res.status(200).send('OK');
  
  try {
    // Check each monitored brand
    for (const brand of CONFIG.BRANDS_TO_MONITOR) {
      console.log(`🔍 Checking stock for: ${brand}`);
      const stockStatus = await checkBrandStock(brand);
      const lastState = lastNotificationState[brand];
      
      console.log(`📊 ${brand}: ${stockStatus.inStockProducts}/${stockStatus.totalProducts} in stock`);
      
      // All products are OOS - send alert if state changed
      if (stockStatus.allOOS && lastState !== 'OOS') {
        console.log(`🚨 ${brand} - ALL OUT OF STOCK`);
        await sendEmail(
          `🚨 ALL ${brand} Products OUT OF STOCK`,
          `All ${stockStatus.totalProducts} products for "${brand}" are now out of stock.\n\n` +
          `⚠️ ACTION REQUIRED: Hide this brand from your brand page.\n\n` +
          `Brand: ${brand}\n` +
          `Total Products: ${stockStatus.totalProducts}\n` +
          `Out of Stock: ${stockStatus.oosProducts}\n\n` +
          `Timestamp: ${new Date().toISOString()}`
        );
        lastNotificationState[brand] = 'OOS';
      }
      
      // At least one product back in stock
      else if (!stockStatus.allOOS && stockStatus.inStockProducts > 0 && lastState === 'OOS') {
        console.log(`✅ ${brand} - BACK IN STOCK`);
        await sendEmail(
          `✅ ${brand} Products BACK IN STOCK`,
          `Good news! ${stockStatus.inStockProducts} product(s) for "${brand}" are back in stock.\n\n` +
          `✅ ACTION REQUIRED: Show this brand on your brand page.\n\n` +
          `Brand: ${brand}\n` +
          `Total Products: ${stockStatus.totalProducts}\n` +
          `In Stock: ${stockStatus.inStockProducts}\n` +
          `Out of Stock: ${stockStatus.oosProducts}\n\n` +
          `Timestamp: ${new Date().toISOString()}`
        );
        lastNotificationState[brand] = 'IN_STOCK';
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    emailMethod: emailMethod,
    monitoring: CONFIG.BRANDS_TO_MONITOR,
    timestamp: new Date().toISOString()
  });
});

// Manual trigger endpoint for testing
app.get('/check-now', async (req, res) => {
  try {
    console.log('🔄 Manual check triggered');
    const results = {};
    for (const brand of CONFIG.BRANDS_TO_MONITOR) {
      results[brand] = await checkBrandStock(brand);
    }
    res.json(results);
  } catch (error) {
    console.error('❌ Error in manual check:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW: Debug endpoint - check your configuration
app.get('/debug-config', (req, res) => {
  res.json({
    shopifyShop: CONFIG.SHOPIFY_SHOP,
    hasAccessToken: !!CONFIG.SHOPIFY_ACCESS_TOKEN,
    accessTokenLength: CONFIG.SHOPIFY_ACCESS_TOKEN?.length || 0,
    hasWebhookSecret: !!CONFIG.SHOPIFY_WEBHOOK_SECRET,
    webhookSecretLength: CONFIG.SHOPIFY_WEBHOOK_SECRET?.length || 0,
    webhookSecretPreview: CONFIG.SHOPIFY_WEBHOOK_SECRET ? 
      CONFIG.SHOPIFY_WEBHOOK_SECRET.substring(0, 4) + '...' + CONFIG.SHOPIFY_WEBHOOK_SECRET.substring(CONFIG.SHOPIFY_WEBHOOK_SECRET.length - 4) : 
      'NOT SET'
  });
});

// Test email endpoint
app.get('/test-email', async (req, res) => {
  try {
    console.log('📧 Testing email...');
    const result = await sendEmail(
      '🧪 Test Email from Shopify Monitor',
      `This is a test email to verify your email configuration is working.\n\n` +
      `Method: ${emailMethod}\n` +
      `From: ${CONFIG.EMAIL_FROM}\n` +
      `To: ${CONFIG.EMAIL_TO}\n` +
      `Timestamp: ${new Date().toISOString()}\n\n` +
      `If you're seeing this, your email setup is working correctly! ✅`
    );
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Test email sent! Check your inbox at ' + CONFIG.EMAIL_TO,
        method: result.method,
        messageId: result.messageId 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error,
        suggestion: 'Try using SendGrid instead - Gmail SMTP often gets blocked by hosting providers'
      });
    }
  } catch (error) {
    console.error('❌ Test email failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// NEW: List all registered webhooks
app.get('/admin/webhooks', async (req, res) => {
  try {
    const response = await fetch(
      `${CONFIG.SHOPIFY_SHOP}/admin/api/2024-10/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const data = await response.json();
    res.json(data);
    console.log('📋 Registered webhooks:', data.webhooks?.length || 0);
  } catch (error) {
    console.error('❌ Error fetching webhooks:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW: Register webhook programmatically
app.post('/admin/register-webhook', async (req, res) => {
  const webhookUrl = req.body.url || `https://${req.get('host')}/webhook/inventory`;
  
  try {
    const response = await fetch(
      `https://${CONFIG.SHOPIFY_SHOP}/admin/api/2024-10/webhooks.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          webhook: {
            topic: 'inventory_levels/update',
            address: webhookUrl,
            format: 'json'
          }
        })
      }
    );
    
    const data = await response.json();
    
    if (response.ok) {
      res.json({ success: true, webhook: data.webhook });
      console.log('✅ Webhook registered:', data.webhook.id);
    } else {
      res.status(500).json({ success: false, error: data });
      console.error('❌ Webhook registration failed:', data);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
    console.error('❌ Error registering webhook:', error);
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Shopify Brand Inventory Monitor',
    status: 'running',
    emailMethod: emailMethod,
    monitoring: CONFIG.BRANDS_TO_MONITOR.length + ' brands',
    endpoints: {
      health: '/health',
      webhook: '/webhook/inventory (POST)',
      manualCheck: '/check-now',
      testEmail: '/test-email',
      listWebhooks: '/admin/webhooks',
      registerWebhook: '/admin/register-webhook (POST)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
  console.log(`📦 Monitoring ${CONFIG.BRANDS_TO_MONITOR.length} brands`);
  console.log(`📧 Email method: ${emailMethod}`);
});
