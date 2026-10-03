try { require('dotenv').config(); } catch (e) {}
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: 'Method Not Allowed',
    };
  }

  const query = event.queryStringParameters || {};
  const token = query.id || query.session_id || query.url;
  if (!token) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing session id parameter' }),
    };
  }

  const safeToken = path.basename(token).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safeToken) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid session token' }),
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    const missingVars = [];
    if (!supabaseUrl) missingVars.push('SUPABASE_URL');
    if (!supabaseKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');
    const errorMsg = `Server configuration error: Missing environment variable(s): ${missingVars.join(', ')}. Please configure them in Netlify Site configuration -> Environment variables.`;
    console.error(errorMsg);
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: errorMsg }),
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    let targetFilename = safeToken;
    let sessionMeta = null;
    const sessionMetaFilename = `temp_session_${safeToken}.json`;

    // Try reading session metadata
    try {
      const { data: metaBlob, error: metaErr } = await supabase.storage
        .from('GestureSnap')
        .download(sessionMetaFilename);

      if (!metaErr && metaBlob) {
        const text = await metaBlob.text();
        sessionMeta = JSON.parse(text);
        if (sessionMeta.photo_path) {
          targetFilename = sessionMeta.photo_path;
        }
      }
    } catch (e) {}

    const now = Date.now();

    // Check expiration if metadata exists
    if (sessionMeta && sessionMeta.expires_at) {
      const expiresAt = new Date(sessionMeta.expires_at).getTime();
      if (expiresAt <= now) {
        // Delete expired session and image
        await supabase.storage.from('GestureSnap').remove([sessionMetaFilename, targetFilename]);
        return {
          statusCode: 410,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'This temporary photo strip has expired and been deleted.' }),
        };
      }
    }

    // Retrieve file buffer from Supabase Storage
    const { data: blobData, error: downloadError } = await supabase.storage
      .from('GestureSnap')
      .download(targetFilename);

    if (downloadError || !blobData) {
      console.error('Supabase Storage download error:', downloadError ? downloadError.message : 'File not found');
      return {
        statusCode: 404,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Photo strip not found or session has expired.' }),
      };
    }

    const arrayBuffer = await blobData.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    const ext = path.extname(targetFilename).toLowerCase();
    const contentType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';

    const responseHeaders = {
      ...headers,
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    };

    const isDownload = query.download === '1' || query.download === 'true';

    if (isDownload) {
      const nowObj = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${nowObj.getFullYear()}-${pad(nowObj.getMonth() + 1)}-${pad(nowObj.getDate())}`;
      const uniqueFilename = `GestureSnap-PhotoStrip-${dateStr}.png`;

      responseHeaders['Content-Disposition'] = `attachment; filename="${uniqueFilename}"`;
    } else {
      // Preview mode
      responseHeaders['Content-Disposition'] = 'inline';
    }

    return {
      statusCode: 200,
      headers: responseHeaders,
      body: imageBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Download Netlify function error:', error);
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
