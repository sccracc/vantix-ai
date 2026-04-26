const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let googleTokenCache = {
  accessToken: '',
  expiresAt: 0,
};

export function corsHeaders(extraHeaders = 'Content-Type') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': extraHeaders,
  };
}

export function jsonResponse(body, status, extraHeaders = 'Content-Type') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(extraHeaders),
    },
  });
}

export function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  return key;
}

export async function stripeRequest(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body).toString() } : {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Stripe request failed (${resp.status})`);
  }
  return data;
}

export async function stripeFormRequest(path, formFields) {
  return stripeRequest(path, { method: 'POST', body: formFields });
}

export async function getOrCreateStripeCustomer({ uid, email, name, existingCustomerId }) {
  if (existingCustomerId) {
    try {
      const existing = await stripeRequest(`/customers/${encodeURIComponent(existingCustomerId)}`);
      if (existing?.id) return existing.id;
    } catch {
      // Customer exists in the other Stripe mode; create a mode-appropriate one.
    }
  }

  const customer = await stripeFormRequest('/customers', {
    email,
    name,
    'metadata[firebaseUid]': uid,
  });
  return customer.id;
}

export async function getFirestoreAccess() {
  const accessToken = await getGoogleAccessToken();
  const projectId = getFirebaseProjectId();
  return { accessToken, projectId };
}

export async function getFirestoreUserDoc(uid, accessToken, projectId) {
  const resp = await fetch(firestoreUserUrl(uid, projectId), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (resp.status === 404) return {};
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore user lookup failed (${resp.status})`);
  }
  const doc = await resp.json();
  return fromFirestoreFields(doc.fields || {});
}

export async function patchFirestoreUser(uid, patch, accessToken, projectId) {
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

export function getFirebaseProjectId() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('Missing FIREBASE_PROJECT_ID environment variable');
  return projectId;
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache.accessToken && googleTokenCache.expiresAt - 60 > now) {
    return googleTokenCache.accessToken;
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY environment variable');
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  const assertion = await createServiceAccountJwt({
    clientEmail,
    privateKey,
    tokenUrl: FIREBASE_TOKEN_URL,
  });

  const resp = await fetch(FIREBASE_TOKEN_URL, {
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
  googleTokenCache = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600),
  };
  return googleTokenCache.accessToken;
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

function firestoreUserUrl(uid, projectId) {
  return `${FIRESTORE_BASE_URL}/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
}

function fromFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = fromFirestoreValue(value);
  return out;
}

function fromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return !!value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue?.fields || {});
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(fromFirestoreValue);
  return null;
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
