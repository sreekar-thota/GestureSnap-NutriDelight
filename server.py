import http.server
import socketserver
import os
import json
import urllib.parse
import socket
import time
import sqlite3
import secrets
import threading
from datetime import datetime

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
DB_PATH = os.path.join(BASE_DIR, 'gesturesnap_temp.db')
QR_EXPIRY_SECONDS = 60  # Matches existing QR countdown duration

os.makedirs(UPLOAD_DIR, exist_ok=True)

def init_db():
    """Initialize SQLite database for temporary photo sessions."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS temporary_photos (
                session_id TEXT PRIMARY KEY,
                photo_path TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            )
        ''')
        conn.commit()

init_db()

def cleanup_expired_sessions():
    """
    Checks for expired temporary photo records and deletes them.
    Uses: WHERE expires_at <= CURRENT_TIMESTAMP
    Also deletes corresponding temporary image files from storage.
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            c = conn.cursor()
            # Select expired temporary photo records
            c.execute('SELECT session_id, photo_path FROM temporary_photos WHERE expires_at <= CURRENT_TIMESTAMP')
            expired_records = c.fetchall()

            for session_id, photo_path in expired_records:
                try:
                    if photo_path and os.path.exists(photo_path):
                        os.remove(photo_path)
                        print(f"[Cleanup] Deleted expired file: {photo_path}")
                except Exception as e:
                    print(f"[Cleanup] Error deleting file {photo_path}: {e}")

            if expired_records:
                c.execute('DELETE FROM temporary_photos WHERE expires_at <= CURRENT_TIMESTAMP')
                conn.commit()
                print(f"[Cleanup] Deleted {len(expired_records)} expired session records from database.")

            # Housekeeping: Remove orphaned files in UPLOAD_DIR older than 60 seconds
            now = time.time()
            for fname in os.listdir(UPLOAD_DIR):
                if fname == '.gitkeep':
                    continue
                fpath = os.path.join(UPLOAD_DIR, fname)
                if os.path.isfile(fpath):
                    c.execute('SELECT 1 FROM temporary_photos WHERE photo_path = ?', (fpath,))
                    if not c.fetchone():
                        # File is not referenced by an active session
                        try:
                            mtime = os.path.getmtime(fpath)
                            if now - mtime > 60:
                                os.remove(fpath)
                                print(f"[Cleanup] Removed unreferenced file: {fname}")
                        except Exception:
                            pass
    except Exception as e:
        print(f"[Cleanup] Cleanup error: {e}")

def start_background_cleaner():
    """Periodically runs cleanup in a background daemon thread."""
    def worker():
        while True:
            time.sleep(5)
            cleanup_expired_sessions()
    t = threading.Thread(target=worker, daemon=True)
    t.start()

start_background_cleaner()

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

LOCAL_IP = get_local_ip()
print(f"[GestureSnap Server] Local IP: http://{LOCAL_IP}:{PORT}")

class GestureSnapHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization')
        # Prevent browser caching of dev assets so code changes appear immediately
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        # Trigger cleanup on incoming request
        cleanup_expired_sessions()

        parsed = urllib.parse.urlparse(self.path)

        # Handle explicit delete/invalidate endpoint
        if parsed.path in ('/api/delete', '/api/invalidate'):
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length) if content_length > 0 else b'{}'
                data = json.loads(body.decode('utf-8')) if body else {}
                query = urllib.parse.parse_qs(parsed.query)
                session_id = data.get('id') or data.get('session_id') or query.get('id', [''])[0]

                if session_id:
                    with sqlite3.connect(DB_PATH) as conn:
                        c = conn.cursor()
                        c.execute('SELECT photo_path FROM temporary_photos WHERE session_id = ?', (session_id,))
                        row = c.fetchone()
                        if row and row[0] and os.path.exists(row[0]):
                            try:
                                os.remove(row[0])
                            except Exception:
                                pass
                        c.execute('DELETE FROM temporary_photos WHERE session_id = ?', (session_id,))
                        conn.commit()

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "message": "Session invalidated"}).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
                return

        if parsed.path == '/api/upload':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)
                
                file_data = None
                duration = QR_EXPIRY_SECONDS
                
                try:
                    data = json.loads(body.decode('utf-8'))
                    if 'duration' in data and isinstance(data['duration'], (int, float)) and data['duration'] > 0:
                        duration = int(data['duration'])
                    if 'image' in data:
                        import base64
                        img_str = data['image'].split(',')[1] if ',' in data['image'] else data['image']
                        file_data = base64.b64decode(img_str)
                except Exception:
                    file_data = body

                if not file_data:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No image data provided"}).encode('utf-8'))
                    return

                # Generate cryptographically unpredictable session ID token
                session_id = f"gs_{secrets.token_urlsafe(16)}"
                filename = f"temp_{session_id}.png"
                filepath = os.path.join(UPLOAD_DIR, filename)

                with open(filepath, 'wb') as f:
                    f.write(file_data)

                # Store temporary record in database with explicit expires_at timestamp
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute('''
                        INSERT INTO temporary_photos (session_id, photo_path, created_at, expires_at)
                        VALUES (?, ?, CURRENT_TIMESTAMP, datetime('now', '+' || ? || ' seconds'))
                    ''', (session_id, filepath, duration))
                    conn.commit()

                download_path = f"/download.html?id={session_id}"
                full_qr_url = f"http://{LOCAL_IP}:{PORT}{download_path}"
                
                response_data = {
                    "success": True,
                    "id": session_id,
                    "session_id": session_id,
                    "expires_in": duration,
                    "downloadUrl": download_path,
                    "fullQrUrl": full_qr_url
                }

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(response_data).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
                return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        self.do_POST()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        
        # Endpoint to verify and download photo strip
        if parsed.path == '/api/download':
            # Cleanup expired sessions on download check
            cleanup_expired_sessions()

            query = urllib.parse.parse_qs(parsed.query)
            token = query.get('id', [''])[0] or query.get('session_id', [''])[0] or query.get('url', [''])[0]

            if not token:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing session id parameter"}).encode('utf-8'))
                return

            # Query database for session and verify expiration
            with sqlite3.connect(DB_PATH) as conn:
                c = conn.cursor()
                c.execute('''
                    SELECT session_id, photo_path, created_at, expires_at,
                           (expires_at <= CURRENT_TIMESTAMP) as is_expired
                    FROM temporary_photos WHERE session_id = ?
                ''', (token,))
                row = c.fetchone()

                if not row:
                    # Session not found or already deleted
                    self.send_response(404)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Photo strip not found or session has expired."}).encode('utf-8'))
                    return

                session_id, photo_path, created_at, expires_at, is_expired = row

                # Check if session has expired
                if is_expired:
                    # Delete record and corresponding file
                    c.execute('DELETE FROM temporary_photos WHERE session_id = ?', (session_id,))
                    conn.commit()
                    if photo_path and os.path.exists(photo_path):
                        try:
                            os.remove(photo_path)
                        except Exception:
                            pass
                    self.send_response(410)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "This temporary photo strip has expired and been deleted."}).encode('utf-8'))
                    return

                # Verify file still exists on disk
                if not photo_path or not os.path.exists(photo_path) or not os.path.isfile(photo_path):
                    c.execute('DELETE FROM temporary_photos WHERE session_id = ?', (session_id,))
                    conn.commit()
                    self.send_response(404)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Photo file not found."}).encode('utf-8'))
                    return

                # Serve image data
                is_download = query.get('download', ['0'])[0] in ('1', 'true')
                date_str = time.strftime('%Y-%m-%d')
                
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.send_header('Pragma', 'no-cache')
                
                if is_download:
                    self.send_header('Content-Disposition', f'attachment; filename="GestureSnap-PhotoStrip-{date_str}.png"')
                else:
                    self.send_header('Content-Disposition', 'inline')

                with open(photo_path, 'rb') as f:
                    content = f.read()

                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        # Serve static files as default
        super().do_GET()

if __name__ == '__main__':
    with socketserver.TCPServer(("", PORT), GestureSnapHandler) as httpd:
        print(f"GestureSnap Server running at http://localhost:{PORT}")
        httpd.serve_forever()
