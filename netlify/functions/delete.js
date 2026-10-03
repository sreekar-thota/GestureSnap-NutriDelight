try { require('dotenv').config(); } catch (e) {}
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  let sessionId = '';
  const query = event.queryStringParameters || {};
  if (query.id || query.session_id) {
    sessionId = query.id || query.session_id;
  } else if (event.body) {
    try {
      const body = JSON.parse(event.body);
      sessionId = body.id || body.session_id || '';
    } catch (e) {}
  }

  if (!sessionId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing session id' }),
    };
  }

  const safeSessionId = path.basename(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const sessionMetaFilename = `temp_session_${safeSessionId}.json`;
      let imageFilename = `temp_${safeSessionId}.png`;

      try {
        const { data: metaBlob } = await supabase.storage
          .from('GestureSnap')
          .download(sessionMetaFilename);
        if (metaBlob) {
          const text = await metaBlob.text();
          const meta = JSON.parse(text);
          if (meta.photo_path) imageFilename = meta.photo_path;
        }
      } catch (err) {}

      await supabase.storage.from('GestureSnap').remove([
        sessionMetaFilename,
        imageFilename,
        `temp_${safeSessionId}.jpg`,
        `temp_${safeSessionId}.png`,
        safeSessionId,
      ]);
    } catch (e) {
      console.error('Delete Netlify function error:', e);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, message: 'Session invalidated and deleted' }),
  };
};
