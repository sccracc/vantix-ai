import {
  corsHeaders,
  jsonResponse,
  stripeRequest,
  stripeFormRequest,
  getFirestoreAccess,
  getFirestoreUserDoc,
  patchFirestoreUser,
  getOrCreateStripeCustomer,
} from './_lib/billing.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed' } }, 405);
  }

  try {
    const body = await req.json();
    const uid = String(body?.uid || '').trim();
    const requestedPrice = String(body?.priceId || body?.planId || '').trim();
    const fallbackEmail = String(body?.email || '').trim();
    if (!uid) return jsonResponse({ error: { message: 'Missing uid' } }, 400);

    const stripePriceId = await resolveStripePriceId(requestedPrice);
    const { projectId, accessToken } = await getFirestoreAccess();
    const userDoc = await getFirestoreUserDoc(uid, accessToken, projectId);
    const customerId = await getOrCreateStripeCustomer({
      uid,
      email: String(userDoc.email || fallbackEmail || ''),
      name: String(userDoc.displayName || ''),
      existingCustomerId: String(userDoc.stripeCustomerId || ''),
    });

    if (!userDoc.stripeCustomerId || userDoc.stripeCustomerId !== customerId) {
      await patchFirestoreUser(uid, { stripeCustomerId: customerId }, accessToken, projectId);
    }

    const origin = new URL(req.url).origin;
    const planId = resolvePlanKey(requestedPrice);
    const session = await stripeFormRequest('/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      allow_promotion_codes: 'true',
      client_reference_id: uid,
      'line_items[0][price]': stripePriceId,
      'line_items[0][quantity]': '1',
      'metadata[firebaseUid]': uid,
      'metadata[planId]': planId,
      'subscription_data[metadata][firebaseUid]': uid,
      'subscription_data[metadata][planId]': planId,
    });

    return jsonResponse({ url: session.url }, 200);
  } catch (error) {
    return jsonResponse({ error: { message: error?.message || 'Failed to create checkout session' } }, 500);
  }
}

async function resolveStripePriceId(input) {
  const priceMap = {
    starter: process.env.STRIPE_STARTER_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
    ultra: process.env.STRIPE_ULTRA_PRICE_ID,
  };
  const normalized = String(input || '').trim();
  if (!normalized) throw new Error('Missing priceId');
  if (priceMap[normalized]) return await normalizeStripePriceOrProductId(priceMap[normalized]);
  const exactMatch = Object.values(priceMap).find(value => value === normalized);
  if (exactMatch) return await normalizeStripePriceOrProductId(exactMatch);
  if (normalized.startsWith('price_')) return normalized;
  if (normalized.startsWith('prod_')) {
    return await findActiveRecurringPriceForProduct(normalized);
  }
  throw new Error('Unsupported subscription tier');
}

function resolvePlanKey(input) {
  const normalized = String(input || '').trim();
  const knownKeys = ['starter', 'pro', 'ultra'];
  if (knownKeys.includes(normalized)) return normalized;
  if (normalized === process.env.STRIPE_STARTER_PRICE_ID) return 'starter';
  if (normalized === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (normalized === process.env.STRIPE_ULTRA_PRICE_ID) return 'ultra';
  return 'unknown';
}

async function normalizeStripePriceOrProductId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('Missing Stripe price ID');
  if (normalized.startsWith('price_')) return normalized;
  if (normalized.startsWith('prod_')) {
    return await findActiveRecurringPriceForProduct(normalized);
  }
  return normalized;
}

async function findActiveRecurringPriceForProduct(productId) {
  const resp = await stripeRequest(`/prices?product=${encodeURIComponent(productId)}&active=true&type=recurring&limit=100`);
  const prices = Array.isArray(resp.data) ? resp.data : [];
  if (!prices.length) {
    throw new Error(`No active recurring price found for product ${productId}`);
  }

  const preferred = prices.find(price => price?.recurring?.interval === 'month') || prices[0];
  return preferred.id;
}
