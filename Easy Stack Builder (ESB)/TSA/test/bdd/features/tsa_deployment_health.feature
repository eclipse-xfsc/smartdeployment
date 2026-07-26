Feature: TSA Kubernetes Service readiness
  The TSA deployer must publish Deployed only after the deployed Kubernetes
  Services are routable to at least one ready backend endpoint.

  Scenario: TSA namespace is available
    Given the TSA deployment workflow completed
    Then the TSA namespace exists and is reachable

  Scenario: TSA Services have ready backends
    When the deployment health pack lists selector-backed Services
    Then every listed Service has at least one ready EndpointSlice or Endpoints address

  Scenario: Deployment status fails closed
    Given any required Service has no ready backend endpoint
    Then the health pack exits with a non-zero status
    And the Deployed output contract is not published
