Feature: PCM deployment health acceptance
  The acceptance pack validates deployment infrastructure and service health only.
  It does not execute credential issuance, wallet synchronization, revocation, login, or policy workflows.

  Scenario: PCM namespace is available
    Given PCM has been deployed to the reference Kubernetes namespace
    Then the namespace exists and is reachable

  Scenario: PCM workloads become ready
    Given the PCM namespace contains the deployed workloads
    When the acceptance runner waits for Deployments and Pods
    Then every Deployment is Available
    And every Pod is Ready

  Scenario: The selected PCM endpoint is reachable over verified TLS
    Given an optional health URL and trusted CA bundle are supplied
    When the acceptance runner requests the URL
    Then certificate verification succeeds
    And the endpoint returns a successful HTTP response

  Scenario: Health validation fails closed
    Given a required namespace, workload, Pod, or selected endpoint is unhealthy
    Then the acceptance runner exits with a non-zero status
