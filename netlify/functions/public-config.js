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

exports.handler = async function handler() {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY in Netlify environment variables.',
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({
      supabaseUrl,
      supabaseAnonKey,
    }),
  };
};
