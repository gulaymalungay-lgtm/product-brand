const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const fs = require('fs');

// Configuration
const CONFIG = {
  SHOPIFY_SHOP: 'your-store.myshopify.com',
  SHOPIFY_ACCESS_TOKEN: 'your-admin-api-token',
  EMAIL_TO: 'your-email@example.com',
  BRANDS_TO_MONITOR: ['Brand A', 'Brand B', 'Brand C']
};

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-gmail@gmail.com',
    pass: 'your-app-password'
  }
});

// File to store last known state
const STATE_FILE = 'brand-state.json';

// Load previous state
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading state:', error);
  }
  return {};
}

// Save current state
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error saving state:', error);
  }
}

// Fetch all products for a brand using Admin API
async function getProductsForBrand(vendor) {
  let allProducts = [];
  let pageInfo = null;
  let hasNextPage = true;

  while (hasNextPage) {
    let url = `https://${CONFIG.SHOPIFY_SHOP}/admin/api/2024-10/products.json?vendor=${encodeURIComponent(vendor)}&limit=250`;
    
    if (pageInfo) {
      url += `&page_info=${pageInfo}`;
    }

    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    allProducts = allProducts.concat(data.products || []);

    // Check for pagination
    const linkHeader = response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<[^>]*page_info=([^>]+)>; rel="next"/);
      pageInfo = match ? match[1] : null;
      hasNextPage = !!pageInfo;
    } else {
      hasNextPage = false;
    }
  }

  return allProducts;
}

// Check stock status for a brand
async function checkBrandStock(vendor) {
  console.log(`Checking stock for: ${vendor}`);
  
  const products = await getProductsForBrand(vendor);
  
  if (products.length === 0) {
    console.log(`No products found for ${vendor}`);
    return null;
  }

  let totalProducts = products.length;
  let oosProducts = 0;
  let productDetails = [];

  for (const product of products) {
    let productTotalStock = 0;
    
    for (const variant of product.variants) {
      productTotalStock += variant.inventory_quantity || 0;
    }
    
    const isOOS = productTotalStock <= 0;
    if (isOOS) {
      oosProducts++;
    }

    productDetails.push({
      title: product.title,
      stock: productTotalStock,
      isOOS: isOOS
    });
  }

  return {
    vendor,
    allOOS: totalProducts === oosProducts,
    totalProducts,
    oosProducts,
    inStockProducts: totalProducts - oosProducts,
    productDetails
  };
}

// Send email notification
async function sendEmail(subject, message) {
  try {
    await transporter.sendMail({
      from: 'your-gmail@gmail.com',
      to: CONFIG.EMAIL_TO,
      subject: subject,
      text: message,
      html: `<pre>${message}</pre>`
    });
    console.log('✅ Email sent:', subject);
  } catch (error) {
    console.error('❌ Error sending email:', error.message);
  }
}

// Main function
async function checkAllBrands() {
  console.log('\n=== Starting Brand Stock Check ===');
  console.log(`Time: ${new Date().toLocaleString()}\n`);

  const previousState = loadState();
  const currentState = {};

  for (const brand of CONFIG.BRANDS_TO_MONITOR) {
    try {
      const stockStatus = await checkBrandStock(brand);
      
      if (!stockStatus) {
        console.log(`⚠️  ${brand}: No products found\n`);
        continue;
      }

      currentState[brand] = stockStatus.allOOS ? 'OOS' : 'IN_STOCK';
      const previousBrandState = previousState[brand];

      console.log(`📊 ${brand}:`);
      console.log(`   Total Products: ${stockStatus.totalProducts}`);
      console.log(`   In Stock: ${stockStatus.inStockProducts}`);
      console.log(`   Out of Stock: ${stockStatus.oosProducts}`);
      console.log(`   Status: ${stockStatus.allOOS ? '🔴 ALL OOS' : '🟢 Some in stock'}\n`);

      // State changed from IN_STOCK to OOS
      if (stockStatus.allOOS && previousBrandState !== 'OOS') {
        console.log(`🚨 ALERT: ${brand} is now completely out of stock!`);
        
        await sendEmail(
          `🚨 ALL ${brand} Products OUT OF STOCK`,
          `All ${stockStatus.totalProducts} products for "${brand}" are now out of stock.\n\n` +
          `⚠️  Action Required: Hide this brand from your brand page.\n\n` +
          `Brand: ${brand}\n` +
          `Total Products: ${stockStatus.totalProducts}\n` +
          `Out of Stock: ${stockStatus.oosProducts}\n\n` +
          `Checked at: ${new Date().toLocaleString()}`
        );
      }

      // State changed from OOS to IN_STOCK
      else if (!stockStatus.allOOS && previousBrandState === 'OOS') {
        console.log(`✅ GOOD NEWS: ${brand} has products back in stock!`);
        
        await sendEmail(
          `✅ ${brand} Products BACK IN STOCK`,
          `Good news! ${stockStatus.inStockProducts} product(s) for "${brand}" are back in stock.\n\n` +
          `✓ Action Required: Show this brand on your brand page.\n\n` +
          `Brand: ${brand}\n` +
          `Total Products: ${stockStatus.totalProducts}\n` +
          `In Stock: ${stockStatus.inStockProducts}\n` +
          `Out of Stock: ${stockStatus.oosProducts}\n\n` +
          `Checked at: ${new Date().toLocaleString()}`
        );
      }

      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error(`❌ Error checking ${brand}:`, error.message);
    }
  }

  // Save current state for next run
  saveState(currentState);
  
  console.log('\n=== Check Complete ===\n');
}

// Run the check
checkAllBrands()
  .then(() => {
    console.log('Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });