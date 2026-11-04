"""HTTPS client with isolated cookies, bounded reads and no credential logging."""
import http.cookiejar
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


@dataclass
class Response:
    status: int
    headers: object
    payload: object


class ApiClient:
    def __init__(self, origin):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'https' or (
            not parsed.netloc or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in ('', '/')
        ):
            raise ValueError('OCM_BASE_URL must be an HTTPS origin without a path or credentials.')
        self.origin = origin.rstrip('/')
        self.cookies = http.cookiejar.CookieJar()
        self.csrf = None
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None, csrf=False, key=None, page=False):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('Only same-origin request paths are accepted.')
        target = self.origin + (path if page else '/orce/ui-api/v1' + path)
        headers = {'Accept': 'text/html' if page else 'application/json', 'Origin': self.origin}
        if csrf:
            if not self.csrf:
                raise AssertionError('Login did not provide a CSRF token.')
            headers['X-CSRF-Token'] = self.csrf
        if key:
            headers['X-Idempotency-Key'] = key
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(target, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, OSError):
            raise AssertionError('HTTP connection or TLS validation failed.') from None
        with response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise AssertionError('Response exceeded the test-client size limit.')
            if page:
                payload = raw.decode('utf-8')
            else:
                try:
                    payload = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise AssertionError('Expected a JSON API response.') from None
            return Response(response.code, response.headers, payload)
