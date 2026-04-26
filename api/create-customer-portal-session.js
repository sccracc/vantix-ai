import {
  corsHeaders,
  jsonResponse,
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
    const fallbackEmail = String(body?.email || '').trim();
    if (!uid) return jsonResponse({ error: { message: 'Missing uid' } }, 400);

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

    const session = await stripeFormRequest('/billing_portal/sessions', {
      customer: customerId,
      return_url: new URL('/', req.url).toString(),
    });

    return jsonResponse({ url: session.url }, 200);
  } catch (error) {
    return jsonResponse({ error: { message: error?.message || 'Failed to create portal session' } }, 500);
  }
}
