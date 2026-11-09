"""Serve web/ like a static host would (no caching, so edits show up on reload).
Usage: python3 tools/serve.py [port]"""
import http.server, functools, sys, pathlib

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".ttf": "font/ttf"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if True:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(WEB))).serve_forever()
