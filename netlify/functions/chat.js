const { createClient } = require('@supabase/supabase-js');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}

function getBearerToken(event) {
  const authHeader =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    '';
  if (!authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice('Bearer '.length).trim();
}

async function validateSupabaseToken(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const supabaseKey = serviceRoleKey || anonKey;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, reason: 'Supabase server configuration is missing.' };
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) {
    return { ok: false, reason: 'Invalid or expired session token.' };
  }
  return { ok: true, user: data.user };
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: { message: 'Method not allowed.' } });
  }

  const token = getBearerToken(event);
  if (!token) {
    return json(401, { error: { message: 'Missing bearer token.' } });
  }

  const auth = await validateSupabaseToken(token);
  if (!auth.ok) {
    return json(401, { error: { message: auth.reason } });
  }

  const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!deepseekApiKey) {
    return json(500, { error: { message: 'Missing DEEPSEEK_API_KEY.' } });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: { message: 'Invalid JSON body.' } });
  }

  try {
    const upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      },
      body: text,
    };
  } catch (error) {
    return json(502, {
      error: {
        message: 'Upstream DeepSeek request failed.',
        detail: error?.message || 'Unknown error',
      },
    });
  }
};
