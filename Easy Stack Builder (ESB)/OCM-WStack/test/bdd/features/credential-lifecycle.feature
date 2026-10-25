Feature: OCM and PCM credential lifecycle evidence
  @local @native-contract
  Scenario: Native Storage envelopes are decoded without hiding errors
    Given the native list returns grouped credential data
    When ORCE requests a list with an empty presentation filter
    Then the credential IDs and claims are displayed
    And an upstream HTTP 400 remains an error rather than an empty list

  @local @pcm
  Scenario: Personal credentials are scoped to a separately authenticated account
    Given an organizational operator with credential permissions
    When the operator connects an authenticated PCM account
    Then account and holder group come from trusted userinfo
    And a holder key outside that account is rejected
    And disconnecting removes the displayed personal inventory

  @local @retrieval
  Scenario: Importing an offer does not confirm storage
    Given a fresh offering link
    When the link is imported
    Then a Retrieval request ID is shown
    When the pending offer is accepted
    Then the UI explains that persistence must be checked separately

  @local @revocation
  Scenario: Managed status and signature validity remain separate
    Given two local status entries and one credential with unchecked status
    When the list is filtered for revoked credentials
    Then only the revoked entry appears
    And no unchecked credential is reported as verified

  @live @not-executed
  Scenario: Official service versions complete issuance and persistence
    Given a freshly deployed 11.1.0 namespace with working native Storage
    When a new demo SD-JWT offer is issued, imported and accepted
    Then the matching credential is persisted and readable
    And Signer verification succeeds

  @live @not-executed
  Scenario: A recognized production Clearing House issues a participant credential
    Given authorized organization onboarding with a selected provider
    When the provider returns a fresh supported credential offering
    Then the selected wallet accepts and stores it
    And its proof, status, expiry and issuer trust are assessed separately
