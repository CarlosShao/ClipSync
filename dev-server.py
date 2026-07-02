#!/usr/bin/env python3
"""
ClipSync Dev Server — 静态文件 + API 反向代理
端口 1420: 前端静态文件 (/index.html, /*)
         API 代理   (/api/* → http://localhost:3001/api/*)
         WS 代理    (/ws     → ws://localhost:3001/ws)

用法: python3 dev-server.py [port]
默认端口: 1420
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import sys
import os
import json

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1420
BACKEND = "http://localhost:3001"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "desktop", "src")


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("directory", STATIC_DIR)
        super().__init__(*args, **kwargs)

    def log_message(self, format, *args):
        # 简洁日志：只显示方法和路径
        print(f"  [{self.command}] {self.path[:80]}")

    # ====== API Proxy (/api/* → backend) ======
    def _proxy_request(self, method):
        """Forward request to backend, relay response back"""
        target = BACKEND + self.path
        # Read body if present
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        # Build proxied headers (skip hop-by-hop headers)
        skip_headers = {"host", "connection", "keep-alive", "transfer-encoding"}
        headers = {}
        for key, val in self.headers.items():
            if key.lower() not in skip_headers:
                headers[key] = val
        # Override host to backend
        headers["Host"] = "localhost:3001"

        try:
            req = urllib.request.Request(target, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=15) as resp:
                status = resp.status
                resp_headers = resp.headers
                resp_body = resp.read()

                # Send response
                self.send_response(status)
                # Relay response headers (skip problematic ones)
                skip_resp = {"transfer-encoding", "connection", "keep-alive"}
                for key, val in resp_headers.items():
                    if key.lower() not in skip_resp:
                        self.send_header(key, val)
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            err_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            err_msg = json.dumps({"error": f"Proxy error: {str(e)}"}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_msg)))
            self.end_headers()
            self.wfile.write(err_msg)

    def do_GET(self):
        if self.path.startswith("/api/") or self.path == "/api/csrf-token":
            return self._proxy_request("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._proxy_request("POST")
        return super().do_POST()

    def do_PUT(self):
        if self.path.startswith("/api/"):
            return self._proxy_request("PUT")
        return super().do_PUT()

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            return self._proxy_request("DELETE")
        return super().do_DELETE()

    def do_OPTIONS(self):
        """Handle CORS preflight - allow everything since same-origin now"""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


# Use ThreadingTCPServer for concurrent request handling!
# Without this, a slow backend request blocks all other requests.
class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    # Ensure we serve from the right directory
    os.chdir(STATIC_DIR)

    httpd = ThreadedTCPServer(("", PORT), ProxyHandler)
    print(f"\n  ClipSync Dev Server (threaded)")
    print(f"  ════════════════════════════════")
    print(f"  Static : http://localhost:{PORT}/")
    print(f"  API    : http://localhost:{PORT}/api/* -> {BACKEND}/api/*")
    print(f"  WS     : ws://localhost:{PORT}/ws     -> {BACKEND}/ws")
    print(f"  Files  : {STATIC_DIR}")
    print(f"\n  Press Ctrl+C to stop\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
