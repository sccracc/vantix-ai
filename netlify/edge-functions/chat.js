const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function normalizeSupabaseUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return '';
  }
}

function parseJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

async function validateSupabaseToken(accessToken) {
  const supabaseUrl = normalizeSupabaseUrl(Deno.env.get('SUPABASE_URL') || '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const tokenPayload = parseJwtPayload(accessToken);
  const tokenIssuer = tokenPayload?.iss || '';
  const configuredHost = (() => {
    try { return new URL(supabaseUrl).host; } catch (_) { return ''; }
  })();
  const issuerHost = (() => {
    try { return tokenIssuer ? new URL(tokenIssuer).host : ''; } catch (_) { return ''; }
  })();

  if (!supabaseUrl || (!serviceRoleKey && !anonKey)) {
    return { ok: false, reason: 'Supabase server configuration is missing.' };
  }
  if (issuerHost && configuredHost && issuerHost !== configuredHost) {
    return {
      ok: false,
      reason: `Session token is for ${issuerHost}, but server is configured for ${configuredHost}.`,
    };
  }
  if (typeof tokenPayload?.exp === 'number' && (tokenPayload.exp * 1000) <= Date.now()) {
    return { ok: false, reason: 'Session token is expired.' };
  }

  const apiKey = serviceRoleKey || anonKey;
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, reason: `Invalid session token. ${text || `HTTP ${resp.status}`}`.trim() };
    }
    const user = await resp.json().catch(() => null);
    if (!user?.id) {
      return { ok: false, reason: 'Invalid session token.' };
    }
    return { ok: true, user };
  } catch (error) {
    return { ok: false, reason: `Supabase auth check failed. ${error?.message || 'Unknown error'}` };
  }
}

export default async (request) => {
  if (request.method !== 'POST') {
    return json(405, { error: { message: 'Method not allowed.' } });
  }

  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: { message: 'Missing bearer token.' } });
  }
  const accessToken = authHeader.slice('Bearer '.length).trim();
  if (!accessToken) {
    return json(401, { error: { message: 'Missing bearer token.' } });
  }

  const auth = await validateSupabaseToken(accessToken);
  if (!auth.ok) {
    return json(401, { error: { message: auth.reason } });
  }

  const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') || '';
  if (!deepseekApiKey) {
    return json(500, { error: { message: 'Missing DEEPSEEK_API_KEY.' } });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json(400, { error: { message: 'Invalid JSON body.' } });
  }

  try {
    const upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${deepseekApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return json(502, {
      error: {
        message: 'Upstream DeepSeek request failed.',
        detail: error?.message || 'Unknown error',
      },
    });
  }
};
