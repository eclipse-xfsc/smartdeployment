Feature: OCM W-Stack deployed API acceptance
  These scenarios exercise a running application ORCE, not the deployer ORCE.
  Authenticated scenarios share a test session, which is closed after the run.

  @core
  Scenario: The application serves its uibuilder page
    When I request the application page
    Then the uibuilder page and its JavaScript are served

  @core
  Scenario: The runtime is alive
    When I anonymously GET "/health/live"
    Then the response status is 200
    And the runtime reports that it is alive

  @core
  Scenario: The runtime and native dependencies are ready
    When I anonymously GET "/health/ready"
    Then the response status is 200
    And MongoDB and native services are ready without degraded eventing

  @core
  Scenario: Protected credentials reject an anonymous request
    When I anonymously GET "/credentials"
    Then the response status is 401
    And the response error is "AUTHENTICATION_REQUIRED"

  @core
  Scenario: Login establishes a secure 24-hour session
    Given I am signed in as the test operator
    Then the session cookie is Secure HttpOnly and SameSite Strict
    And the session expires within 24 hours

  @core
  Scenario: The operator identity has the permissions needed by this suite
    Given I am signed in as the test operator
    When I GET "/auth/me"
    Then the response status is 200
    And the identity has the required operator permissions

  @core
  Scenario: Credentials can be browsed
    Given I am signed in as the test operator
    When I GET "/credentials?pageSize=10"
    Then the response status is 200
    And the response data contains an items array
    And the credential count and page size are consistent

  @core
  Scenario: Relationships can be browsed
    Given I am signed in as the test operator
    When I GET "/relationships"
    Then the response status is 200
    And the response data contains an items array

  @core
  Scenario: Incoming offers can be browsed
    Given I am signed in as the test operator
    When I GET "/offers"
    Then the response status is 200
    And the response data contains an items array

  @core
  Scenario: Credential types can be browsed
    Given I am signed in as the test operator
    When I GET "/credential-types"
    Then the response status is 200
    And the response data contains an items array

  @core
  Scenario: Clearing provider configuration is visible
    Given I am signed in as the test operator
    When I GET "/clearing/providers"
    Then the response status is 200
    And the Gaia-X provider declares its availability

  @core
  Scenario: Clearing input choices can be browsed
    Given I am signed in as the test operator
    When I GET "/clearing/inputs"
    Then the response status is 200
    And all three Gaia-X input choices are returned

  @core
  Scenario: A missing CSRF token prevents a preference mutation
    Given I am signed in as the test operator
    When I PATCH preferences without a CSRF token
    Then the response status is 403
    And the response error is "CSRF_INVALID"

  @core
  Scenario: A request cannot override its authenticated tenant
    Given I am signed in as the test operator
    When I PATCH preferences with another tenant
    Then the response status is 403
    And the response error is "SCOPE_FORBIDDEN"

  @core
  Scenario: Logout invalidates the previously valid session
    Given I am signed in as the test operator
    When I sign out and reuse the old session cookie
    Then the response status is 401
    And the response error is "AUTHENTICATION_REQUIRED"

  @credential
  Scenario: A selected existing credential can be inspected
    Given I am signed in as the test operator
    When I request the configured credential detail
    Then the response status is 200
    And the detail identifies the selected credential

  @credential
  Scenario: A known valid fixture is verified by the native verifier
    Given I am signed in as the test operator
    When I verify the configured credential
    Then the response status is 200
    And the native verification verdict is valid

  @credential
  Scenario: Provenance includes the selected credential and declared identities
    Given I am signed in as the test operator
    When I request the configured credential provenance
    Then the response status is 200
    And provenance contains the selected credential and declared identity edges

  @clearing
  Scenario: Clearing acquisition reaches confirmed native storage
    Given I am signed in as the test operator
    When I acquire a compliance credential using the configured Gaia-X inputs
    Then the clearing job reaches succeeded with confirmed storage
    And the resulting credential can be read from native storage

  @refresh
  Scenario: Refresh forwards a configured request exactly once for its idempotency key
    Given I am signed in as the test operator
    When I submit the configured refresh request twice with the same key
    Then both responses identify the same submitted operation
