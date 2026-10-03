try { require('dotenv').config(); } catch (e) {}
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const QR_EXPIRY_SECONDS = 60; // Exact QR countdown duration

// Helper to cleanup expired records and objects in Supabase storage
async function cleanupExpiredSupabaseSessions(supabase) {
  try {
    const { data: files, error } = await supabase.storage.from('GestureSnap').list('', { limit: 100 });
    if (error || !files) return;

    const now = Date.now();
    const filesToDelete = [];

    for (const file of files) {
      if (file.name.startsWith('temp_session_') && file.name.endsWith('.json')) {
        // Download metadata
        try {
          const { data: blob } = await supabase.storage.from('GestureSnap').download(file.name);
          if (blob) {
            const text = await blob.text();
            const sessionData = JSON.parse(text);
            const exp = new Date(sessionData.expires_at).getTime();
            if (exp <= now) {
              filesToDelete.push(file.name);
              if (sessionData.photo_path) {
                filesToDelete.push(sessionData.photo_path);
              }
            }
          }
        } catch (err) {}
      } else if (file.created_at) {
        // Any orphan or legacy file older than 5 minutes
        const fileCreated = new Date(file.created_at).getTime();
        if (now - fileCreated > 5 * 60 * 1000) {
          filesToDelete.push(file.name);
        }
      }
    }

    if (filesToDelete.length > 0) {
      const uniqueFiles = [...new Set(filesToDelete)];
      await supabase.storage.from('GestureSnap').remove(uniqueFiles);
      console.log('[Supabase Cleanup] Deleted expired objects:', uniqueFiles);
    }
  } catch (err) {
    console.error('[Supabase Cleanup Error]', err);
  }
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase configuration error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from environment.');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Server configuration error: Supabase credentials missing.',
        }),
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Run cleanup on upload
    await cleanupExpiredSupabaseSessions(supabase);

    let body = {};
    if (event.body) {
      try {
        const rawBody = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf-8')
          : event.body;
        body = JSON.parse(rawBody);
      } catch (e) {
        body = {};
      }
    }

    const image = body.image;
    if (!image) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No image data provided' }),
      };
    }

    const duration = (typeof body.duration === 'number' && body.duration > 0) ? body.duration : QR_EXPIRY_SECONDS;

    const mimeMatch = image.match(/^data:(image\/\w+);base64,/);
    const contentType = mimeMatch ? mimeMatch[1] : 'image/png';
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';

    // Cryptographically secure unpredictable session ID
    const sessionId = `gs_${crypto.randomBytes(16).toString('hex')}`;
    const imageFilename = `temp_${sessionId}.${ext}`;
    const sessionMetaFilename = `temp_session_${sessionId}.json`;

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const reqHeaders = event.headers || {};
    const getHeader = (name) => {
      const lower = name.toLowerCase();
      for (const key of Object.keys(reqHeaders)) {
        if (key.toLowerCase() === lower) return reqHeaders[key];
      }
      return null;
    };

    const rawHost = getHeader('x-forwarded-host') || getHeader('host') || '';
    const protocol = getHeader('x-forwarded-proto') || 'https';

    const PRODUCTION_ORIGIN = 'https://gesturesnap2.netlify.app';
    let baseUrl = PRODUCTION_ORIGIN;

    if (
      rawHost &&
      !rawHost.includes('localhost') &&
      !rawHost.includes('127.0.0.1') &&
      !rawHost.startsWith('192.168.') &&
      !rawHost.startsWith('10.') &&
      !rawHost.includes('supabase')
    ) {
      baseUrl = `${protocol}://${rawHost}`;
    } else if (process.env.URL && !process.env.URL.includes('localhost')) {
      baseUrl = process.env.URL;
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + duration * 1000);

    // Upload image buffer to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('GestureSnap')
      .upload(imageFilename, buffer, {
        contentType: contentType,
        upsert: true,
      });

    if (uploadError) {
      console.error('Supabase Storage upload failed:', uploadError.message || uploadError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Supabase Storage upload failed: ' + (uploadError.message || 'Unknown storage error'),
        }),
      };
    }

    // Save temporary session metadata record
    const sessionMetadata = {
      session_id: sessionId,
      photo_path: imageFilename,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    await supabase.storage
      .from('GestureSnap')
      .upload(sessionMetaFilename, Buffer.from(JSON.stringify(sessionMetadata)), {
        contentType: 'application/json',
        upsert: true,
      });

    const downloadPath = `/download.html?id=${encodeURIComponent(sessionId)}`;
    const fullQrUrl = `${baseUrl.replace(/\/$/, '')}${downloadPath}`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        id: sessionId,
        session_id: sessionId,
        expires_in: duration,
        downloadUrl: downloadPath,
        fullQrUrl: fullQrUrl,
      }),
    };
  } catch (error) {
    console.error('Upload Netlify function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Internal Server Error' }),
    };
  }
};
