export const config = { runtime: 'edge' };

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';

const PLAN_LIMITS = {
  starter: 1000000,
  pro: 5000000,
  ultra: 25000000,
  free: 10000,
  god_mode: 999999999,
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
    const sessionId = String(body?.sessionId || '').trim();
    if (!uid) return jsonResponse({ error: { message: 'Missing uid' } }, 400);
    if (!sessionId) return jsonResponse({ error: { message: 'Missing sessionId' } }, 400);

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=customer`);
    const sessionPlanId = resolvePlanId(session?.metadata?.planId || session?.subscription?.metadata?.planId || '');
    const planId = normalizePlanId(sessionPlanId);
    if (!['starter', 'pro', 'ultra'].includes(planId)) {
      return jsonResponse({ error: { message: 'Checkout session did not map to a paid plan' } }, 400);
    }

    const sessionUid = String(session?.metadata?.firebaseUid || session?.client_reference_id || '');
    if (sessionUid && sessionUid !== uid) {
      return jsonResponse({ error: { message: 'Session user mismatch' } }, 403);
    }

    const customerId = typeof session?.customer === 'object' ? String(session.customer.id || '') : String(session?.customer || '');
    const subscriptionId = typeof session?.subscription === 'object' ? String(session.subscription.id || '') : String(session?.subscription || '');
    const customerEmail = String(session?.customer_details?.email || session?.customer_email || '');
    const accessToken = await getGoogleAccessToken();
    const projectId = getFirebaseProjectId();

    await patchFirestoreUser(
      uid,
      {
        plan: planId,
        planId,
        tokenLimit: PLAN_LIMITS[planId],
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: String(session?.subscription?.status || session?.status || 'active'),
        email: customerEmail,
      },
      accessToken,
      projectId
    );

    return jsonResponse({
      ok: true,
      planId,
      tokenLimit: PLAN_LIMITS[planId],
      subscriptionId,
      customerId,
    }, 200);
  } catch (error) {
    return jsonResponse({ error: { message: error?.message || 'Failed to confirm checkout session' } }, 500);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  return key;
}

async function stripeRequest(path) {
  const resp = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Stripe request failed (${resp.status})`);
  }
  return data;
}

function normalizePlanId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'starter' || normalized === 'pro' || normalized === 'ultra') return normalized;
  return '';
}

function resolvePlanId(value) {
  return normalizePlanId(value) || 'free';
}

async function patchFirestoreUser(uid, patch, accessToken, projectId) {
  const params = new URLSearchParams();
  Object.keys(patch).forEach(key => params.append('updateMask.fieldPaths', key));
  const resp = await fetch(`${firestoreUserUrl(uid, projectId)}?${params.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(patch) }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore user patch failed (${resp.status})`);
  }
}

function firestoreUserUrl(uid, projectId) {
  return `${FIRESTORE_BASE_URL}/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
}

function getFirebaseProjectId() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('Missing FIREBASE_PROJECT_ID environment variable');
  return projectId;
}

async function getGoogleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY environment variable');
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  const assertion = await createServiceAccountJwt({
    clientEmail,
    privateKey,
    tokenUrl: 'https://oauth2.googleapis.com/token',
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Google OAuth token exchange failed (${resp.status})`);
  }

  const json = await resp.json();
  return json.access_token;
}

async function createServiceAccountJwt({ clientEmail, privateKey, tokenUrl }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem) {
  const pem = privateKeyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = toFirestoreValue(value);
  return out;
}

function toFirestoreValue(value) {
  if (value === null || typeof value === 'undefined') return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  return { stringValue: String(value) };
}
