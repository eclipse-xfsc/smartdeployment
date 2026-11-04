import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from behave import given, when, then
from client import ApiClient


REQUIRED_PERMISSIONS = {
    'credentials.read', 'credentials.verify', 'credentials.receive', 'credentials.issue',
    'relationships.read', 'clearing.request'
}


def data(response):
    assert isinstance(response.payload, dict), 'Expected a JSON object.'
    value = response.payload.get('data')
    assert isinstance(value, dict), 'Expected an object in response.data.'
    return value


def accepted(response):
    assert response.status in (200, 202), 'Operation rejected; HTTP %s, code %s.' % (
        response.status, response.payload.get('error', {}).get('code', 'UNKNOWN'))
    return data(response)


def fixture_id():
    value = os.environ.get('OCM_CREDENTIAL_ID', '')
    assert value, 'Set OCM_CREDENTIAL_ID to an existing known-valid fixture.'
    return value


def credential_path(suffix=''):
    return '/credentials/' + quote(fixture_id(), safe='') + suffix


def input_json(name):
    path = os.environ.get(name, '')
    assert path, 'Set %s to an external JSON fixture file.' % name
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise AssertionError('Cannot read JSON fixture named by %s.' % name) from None
    assert isinstance(value, dict), 'Fixture must be a JSON object.'
    return value


def login(api):
    started = datetime.now(timezone.utc)
    response = api.request('POST', '/auth/login', body={
        'username': os.environ['OCM_USERNAME'], 'password': os.environ['OCM_PASSWORD']})
    assert response.status == 200, 'Operator login failed (HTTP %s).' % response.status
    result = data(response)
    api.csrf = result.get('csrfToken')
    assert isinstance(api.csrf, str) and len(api.csrf) == 43, 'Login must return a CSRF token.'
    return response, started


@given('I am signed in as the test operator')
def signed_in(context):
    context.api = context.session_api
    if not context.session_state['active']:
        context.login_response, context.login_started = login(context.api)
        context.session_state['active'] = True
        assert not data(context.login_response).get('passwordChangeRequired'), (
            'Complete the initial password change in the UI before running BDD.')


@when('I request the application page')
def application_page(context):
    context.response = context.api.request('GET', '/orce/', page=True)


@then('the uibuilder page and its JavaScript are served')
def application_served(context):
    assert context.response.status == 200, 'Application page did not return HTTP 200.'
    assert 'text/html' in context.response.headers.get('Content-Type', '')
    assert 'id="app"' in context.response.payload
    assert 'index.js' in context.response.payload
    response = context.api.request('GET', '/orce/index.js', page=True)
    assert response.status == 200, 'UI JavaScript did not return HTTP 200.'
    assert 'javascript' in response.headers.get('Content-Type', '')
    assert 'createApp' in response.payload


@when('I anonymously GET "{path}"')
def anonymous_get(context, path):
    context.response = context.api.request('GET', path)


@when('I GET "{path}"')
def get_path(context, path):
    context.response = context.api.request('GET', path)


@then('the response status is {status:d}')
def response_status(context, status):
    assert context.response.status == status, 'Expected HTTP %s; received %s.' % (
        status, context.response.status)


@then('the response error is "{code}"')
def response_error(context, code):
    assert context.response.payload.get('error', {}).get('code') == code, 'Unexpected error code.'


@then('the runtime reports that it is alive')
def alive(context):
    assert context.response.payload.get('alive') is True


@then('MongoDB and native services are ready without degraded eventing')
def ready(context):
    body = context.response.payload
    assert body.get('ready') is True, 'Application/MongoDB is not ready.'
    assert body.get('nativeReady') is True, 'Native service dependencies are not ready.'
    assert body.get('degraded') is False, 'NATS event delivery is degraded.'
    checks = body.get('dependencies')
    assert isinstance(checks, list) and checks, 'Native readiness checks are missing.'
    assert {'storage', 'retrieval', 'issuer', 'didcomm', 'nats'} <= {item.get('name') for item in checks}, (
        'A required native readiness check is missing.')
    assert all(item.get('ok') is True for item in checks), 'A native dependency check failed.'


@then('the session cookie is Secure HttpOnly and SameSite Strict')
def secure_cookie(context):
    cookie = context.login_response.headers.get('Set-Cookie', '')
    assert cookie.startswith('__Secure-ocm_session='), 'Expected the application session cookie.'
    parts = [p.strip().lower() for p in cookie.split(';')[1:]]
    for flag in ['secure', 'httponly', 'samesite=strict', 'path=/orce/', 'max-age=86400']:
        assert flag in parts, 'Missing session cookie attribute: ' + flag


@then('the session expires within 24 hours')
def session_deadline(context):
    raw = data(context.login_response).get('expiresAt')
    assert isinstance(raw, str), 'Session expiry is missing.'
    expiry = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    duration = (expiry - context.login_started).total_seconds()
    assert 86340 <= duration <= 86430, 'Unexpected absolute session lifetime.'


@then('the identity has the required operator permissions')
def identity(context):
    result = data(context.response)
    assert all(result.get(k) for k in ['subject', 'username', 'tenant', 'account', 'group'])
    assert result['username'].lower() == os.environ['OCM_USERNAME'].lower()
    assert REQUIRED_PERMISSIONS <= set(result.get('permissions', [])), 'Test operator lacks permissions.'


@then('the response data contains an items array')
def items_array(context):
    assert isinstance(data(context.response).get('items'), list), 'Expected data.items array.'


@then('the credential count and page size are consistent')
def credential_count(context):
    result = data(context.response)
    assert len(result['items']) <= 10
    assert isinstance(result.get('total'), int) and result['total'] >= len(result['items'])


@then('the Gaia-X provider declares its availability')
def provider(context):
    result = data(context.response)
    rows = [x for x in result.get('items', []) if x.get('id') == 'gaia-x']
    assert len(rows) == 1, 'Expected exactly one Gaia-X provider.'
    assert isinstance(rows[0].get('requestSupported'), bool)
    assert rows[0].get('state') in ('available', 'unavailable')


@then('all three Gaia-X input choices are returned')
def clearing_choices(context):
    rows = data(context.response).get('items', [])
    assert {x.get('id') for x in rows} == {
        'gaiax-legal-person', 'gaiax-vat-id', 'gaiax-terms-and-conditions'}
    assert all(isinstance(row.get('credentials'), list) for row in rows)


@when('I PATCH preferences without a CSRF token')
def missing_csrf(context):
    context.response = context.api.request('PATCH', '/preferences', body={'locale': 'en'})


@when('I PATCH preferences with another tenant')
def scope_override(context):
    context.response = context.api.request('PATCH', '/preferences',
                                            body={'tenant': 'bdd-forbidden-override'}, csrf=True)


@when('I sign out and reuse the old session cookie')
def logout(context):
    api = ApiClient(os.environ['OCM_BASE_URL'])
    login(api)
    old_cookies = list(api.cookies)
    response = api.request('POST', '/auth/logout', body={}, csrf=True)
    assert response.status == 200, 'Logout failed.'
    for cookie in old_cookies:
        api.cookies.set_cookie(cookie)
    context.response = api.request('GET', '/auth/me')


@when('I request the configured credential detail')
def detail(context):
    context.response = context.api.request('GET', credential_path())


@then('the detail identifies the selected credential')
def selected_detail(context):
    assert data(context.response).get('id') == fixture_id()


@when('I verify the configured credential')
def verify(context):
    context.response = context.api.request('POST', credential_path('/verify'), body={}, csrf=True)


@then('the native verification verdict is valid')
def valid_verdict(context):
    result = data(context.response)
    assert result.get('overall') == 'valid', 'Known-valid fixture did not verify as valid.'
    assert result.get('nativeValid') is True, 'Native verifier did not confirm validity.'


@when('I request the configured credential provenance')
def provenance(context):
    context.response = context.api.request('GET', credential_path('/provenance'))


@then('provenance contains the selected credential and declared identity edges')
def provenance_graph(context):
    result = data(context.response)
    assert result.get('root') == 'credential:' + fixture_id()
    assert isinstance(result.get('nodes'), list) and result['nodes']
    assert isinstance(result.get('edges'), list) and result['edges']
    ids = {x.get('id') for x in result['nodes']}
    assert result['root'] in ids
    assert all(x.get('from') in ids and x.get('to') in ids for x in result['edges'])
    assert any(x.get('role') == 'issuer' for x in result['edges'])
    assert any(x.get('role') == 'holder' for x in result['edges'])
    assert result.get('verified') is False, 'Declared lineage must not claim verified trust.'


@when('I acquire a compliance credential using the configured Gaia-X inputs')
def acquire(context):
    body = input_json('OCM_CLEARING_INPUTS_FILE')
    assert set(body) == {'provider', 'credentials'} and body['provider'] == 'gaia-x'
    assert set(body['credentials']) == {
        'gaiax-legal-person', 'gaiax-vat-id', 'gaiax-terms-and-conditions'}
    result = accepted(context.api.request('POST', '/clearing/requests', body=body,
                                         csrf=True, key=uuid.uuid4().hex))
    job = result.get('resourceId')
    assert isinstance(job, str) and job, 'Clearing did not return a job identifier.'
    deadline = time.monotonic() + int(os.environ.get('OCM_CLEARING_TIMEOUT', '360'))
    path = '/clearing/requests/' + quote(job, safe='')
    while time.monotonic() < deadline:
        response = context.api.request('GET', path)
        assert response.status == 200, 'Clearing job could not be read.'
        result = data(response)
        if result.get('state') in ('succeeded', 'failed', 'unknown', 'received'):
            context.clearing_result = result
            return
        time.sleep(2)
    raise AssertionError('Clearing did not reach a terminal outcome before the deadline.')


@then('the clearing job reaches succeeded with confirmed storage')
def clearing_success(context):
    result = context.clearing_result
    assert result.get('state') == 'succeeded', 'Clearing ended in state ' + str(result.get('state'))
    assert result.get('storageConfirmation') == 'confirmed'
    assert result.get('credentialId'), 'Stored credential identifier is missing.'


@then('the resulting credential can be read from native storage')
def clearing_readback(context):
    key = context.clearing_result['credentialId']
    response = context.api.request('GET', '/credentials/' + quote(key, safe=''))
    assert response.status == 200 and data(response).get('id') == key


@when('I submit the configured refresh request twice with the same key')
def refresh(context):
    body = input_json('OCM_REFRESH_BODY_FILE')
    key = uuid.uuid4().hex
    path = credential_path('/refresh')
    context.refresh_first = accepted(context.api.request('POST', path, body=body, csrf=True, key=key))
    context.refresh_second = accepted(context.api.request('POST', path, body=body, csrf=True, key=key))


@then('both responses identify the same submitted operation')
def refresh_replayed(context):
    one, two = context.refresh_first, context.refresh_second
    assert one.get('state') == two.get('state') == 'submitted'
    assert one.get('requestId') and one['requestId'] == two.get('requestId')
    assert two.get('replayed') is True
    assert one.get('resourceId') == two.get('resourceId') == fixture_id()
