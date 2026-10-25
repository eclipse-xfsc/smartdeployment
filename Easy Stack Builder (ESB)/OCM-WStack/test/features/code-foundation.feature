Feature: Code foundation safeguards
  These scenarios exercise application decisions with a unit-test database double.
  They do not replace real MongoDB, ORCE, NATS or browser acceptance.

  Scenario: Absolute session expiry does not depend on MongoDB TTL cleanup
    Given a persisted UI session whose absolute deadline is now
    When the application validates the session before TTL cleanup
    Then authentication is rejected and the stored row still exists

  Scenario: Expiration cannot be hidden by native active status
    Given a credential that expired in 2000
    When the native status service reports active
    Then the displayed lifecycle is expired

  Scenario: An uncertain operation cannot be blindly repeated
    Given a native mutation whose response timed out
    When the same operation key is submitted again
    Then the result is unknown without a second native dispatch
