#!/usr/bin/env python3
"""Serve a built CloudCLI frontend behind a path-stripping reverse proxy."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from urllib.parse import urlsplit


class ClientHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def send_head(self):
        path = Path(urlsplit(self.path).path)
        if path.suffix == "" and not Path(self.translate_path(self.path)).exists():
            self.path = "/index.html"
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def end_headers(self):
        path = urlsplit(self.path).path
        if path.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    directory = str(Path(sys.argv[1]).resolve())
    port = int(sys.argv[2])
    handler = lambda *args, **kwargs: ClientHandler(*args, directory=directory, **kwargs)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
