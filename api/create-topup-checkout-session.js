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

const TOPUP_PACKS = {
  quick_refill: {
    units: 50000,
    envKey: 'STRIPE_QUICK_REFILL_PRICE_ID',
  },
  power_up: {
    units: 250000,
    envKey: 'STRIPE_POWER_UP_PRICE_ID',
  },
  vault: {
    units: 1000000,
    envKey: 'STRIPE_VAULT_PRICE_ID',
  },
};

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
    const topupId = String(body?.topupId || '').trim();
    const fallbackEmail = String(body?.email || '').trim();
    if (!uid) return jsonResponse({ error: { message: 'Missing uid' } }, 400);
    if (!TOPUP_PACKS[topupId]) return jsonResponse({ error: { message: 'Unsupported top-up pack' } }, 400);

    const priceId = await resolveStripePriceId(TOPUP_PACKS[topupId].envKey);
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
    const session = await stripeFormRequest('/checkout/sessions', {
      mode: 'payment',
      customer: customerId,
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      client_reference_id: uid,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[firebaseUid]': uid,
      'metadata[topupId]': topupId,
      'metadata[units]': String(TOPUP_PACKS[topupId].units),
      'payment_intent_data[metadata][firebaseUid]': uid,
      'payment_intent_data[metadata][topupId]': topupId,
      'payment_intent_data[metadata][units]': String(TOPUP_PACKS[topupId].units),
    });

    return jsonResponse({ url: session.url }, 200);
  } catch (error) {
    return jsonResponse({ error: { message: error?.message || 'Failed to create top-up checkout session' } }, 500);
  }
}

async function resolveStripePriceId(envKey) {
  const value = String(process.env[envKey] || '').trim();
  if (!value) throw new Error(`Missing ${envKey} environment variable`);
  if (value.startsWith('price_')) return value;
  if (value.startsWith('prod_')) return await findActiveOneTimePriceForProduct(value);
  return value;
}

async function findActiveOneTimePriceForProduct(productId) {
  const resp = await stripeRequest(`/prices?product=${encodeURIComponent(productId)}&active=true&type=one_time&limit=100`);
  const prices = Array.isArray(resp.data) ? resp.data : [];
  if (!prices.length) {
    throw new Error(`No active one-time price found for product ${productId}`);
  }
  return prices[0].id;
}
