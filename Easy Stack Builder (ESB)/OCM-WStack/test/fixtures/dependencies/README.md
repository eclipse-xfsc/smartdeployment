# Offline chart snapshots

These source-only fixtures retain the previously downloaded policy 1.4.3 and credential-verification-service 1.0.2 charts, including the latter's library dependency. They are test data, excluded from the installation TGZ. The policy snapshot differs from the runtime wrapper's 1.0.0-helm dependency; the offline test changes only its temporary parent dependency version to exercise the available real templates. No runtime chart version is changed. Runtime preflight must download and semantically validate the exact selected dependencies.
