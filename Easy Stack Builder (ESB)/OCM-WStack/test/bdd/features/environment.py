import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from client import ApiClient


def before_all(context):
    context.session_api = ApiClient(os.environ['OCM_BASE_URL'])
    context.session_state = {'active': False}


def before_scenario(context, scenario):
    context.api = ApiClient(os.environ['OCM_BASE_URL'])


def after_all(context):
    if context.session_state['active']:
        response = context.session_api.request('POST', '/auth/logout', body={}, csrf=True)
        assert response.status == 200, 'Test-session cleanup failed; sign out the test operator.'
