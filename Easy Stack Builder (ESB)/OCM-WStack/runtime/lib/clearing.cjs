'use strict';

const { fail, object } = require('./errors.cjs');
const ENDPOINT = 'https://clearing.gaia-x.eu/api/v1';

// The activity plan fixes this provider and an asynchronous OID4VCI flow.
// No verified trigger/poll/result contract was supplied or located. A Wizard
// presentation API implements a different contract and must not be substituted.
class Clearing {
  async list() {
    return {
      items: [{ id: 'gaia-x', name: 'Gaia-X Clearing Center', url: ENDPOINT,
        protocol: 'OID4VCI', requestSupported: false, state: 'blocked',
        code: 'CLEARING_CONTRACT_UNVERIFIED' }],
      source: 'approved-activity-plan', contractVerified: false
    };
  }

  async acquire(body) {
    object(body, ['provider']);
    if (body.provider !== 'gaia-x') fail(400, 'VALIDATION_ERROR');
    fail(503, 'CLEARING_CONTRACT_UNVERIFIED');
  }
}

module.exports = { Clearing, ENDPOINT };
