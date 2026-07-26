Feature: OCM-WStack deployment health and operational acceptance
  The acceptance pack validates deployment infrastructure and service health only.
  It does not execute credential issuance, verification, revocation, OIDC, or DIDComm workflows.

  Scenario: All OCM workloads become ready
    Given OCM-WStack has been deployed to the reference Kubernetes namespace
    When the acceptance runner waits for every Deployment and StatefulSet
    Then every workload rollout succeeds
    And every running Pod reports all containers ready

  Scenario: Required OCM dependencies are reachable
    Given the OCM namespace contains the required services
    When a temporary health-check Pod opens the documented internal ports
    Then Cassandra, NATS, Redis, PostgreSQL, Keycloak, Vault, DIDComm, Universal Resolver, and Signer are reachable
    And the Keycloak, DIDComm, and Signer health endpoints respond successfully

  Scenario: OCM ingress endpoints are available over verified TLS
    Given the OCM ingresses have load-balancer addresses
    When the acceptance runner connects using TLS certificate verification
    Then the Keycloak realm endpoint is reachable
    And the OCM well-known endpoint is reachable

  Scenario: The deployment output contract is complete
    Given the ORCE deployment output was captured as JSON
    When the acceptance runner validates the output
    Then ocmUrl, keycloakUrl, clientSecret, externalIp, and status are present
    And sensitive values are redacted from the evidence bundle
