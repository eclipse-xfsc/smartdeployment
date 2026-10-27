import {
  createApp,
  h,
  reactive,
  onMounted,
  onUnmounted
} from '/orce/vendor/vue.js';

const locales = {
  "en": {
    "copyInvitation": "Copy invitation URL",
    "inspectOperation": "Inspect operation",
    "app": "OCM W-Stack",
    "subtitle": "Organizational credentials",
    "login": "Sign in",
    "logout": "Sign out",
    "credentials": "Local credentials",
    "receive": "Receive credential",
    "issue": "Issue credential",
    "relationships": "Relationships",
    "roles": "Roles",
    "assignments": "Users",
    "audit": "Audit log",
    "health": "Service health",
    "refresh": "Refresh",
    "loading": "Loading…",
    "empty": "No records found.",
    "error": "The request could not be completed.",
    "forbidden": "You do not have permission for this action.",
    "search": "Search",
    "type": "Type",
    "issuer": "Issuer",
    "holder": "Holder",
    "verifier": "Verifier",
    "id": "Identifier",
    "status": "Status",
    "expires": "Expires",
    "view": "View",
    "verify": "Verify",
    "revoke": "Revoke",
    "delete": "Delete local copy",
    "confirmRevoke": "Revoke this credential? Revocation changes its status and may be irreversible.",
    "confirmDelete": "Delete the local copy? This does not revoke the credential.",
    "confirm": "Apply this change?",
    "close": "Close",
    "claims": "Credential claims",
    "raw": "Show raw credential",
    "provenance": "Provenance",
    "declarations": "Declared by the credential; verification is shown separately.",
    "unknown": "Unknown",
    "not_checked": "Status not checked",
    "valid": "Valid",
    "invalid": "Invalid",
    "indeterminate": "Indeterminate",
    "unsupported": "Unsupported",
    "active": "Active",
    "revoked": "Revoked",
    "not_required": "Not required",
    "cryptographic": "Cryptographic verification",
    "overall": "Overall result",
    "checkedAt": "Checked at",
    "total": "Total matching credentials",
    "next": "Next page",
    "back": "First page",
    "updated": "Last refreshed",
    "offer": "Credential offer",
    "offerHelp": "Paste an OID4VCI offer from the Clearing Center or another approved issuer.",
    "import": "Import offer",
    "accept": "Accept",
    "reject": "Reject",
    "txCode": "Transaction code (if required)",
    "pendingOffers": "Pending offers",
    "clearing": "Gaia-X Clearing Center",
    "clearingHelp": "Select the three signed Gaia-X credentials to submit for Loire compliance.",
    "demo": "Demonstration issuance",
    "demoHelp": "The configured content plugin prepares the offer. The real Signer performs cryptographic signing.",
    "review": "Review and issue",
    "offerResult": "Offer ready for sharing",
    "copy": "Copy",
    "copied": "Copied",
    "succeeded": "Completed",
    "dispatching": "Processing",
    "outcomeUnknown": "The outcome is unknown. Do not submit again with a new key; inspect the operation first.",
    "label": "Label",
    "did": "Peer DID",
    "invitation": "Invitation",
    "createInvitation": "Create invitation",
    "acceptInvitation": "Accept invitation",
    "block": "Block",
    "unblock": "Unblock",
    "remove": "Remove relationship",
    "save": "Save",
    "name": "Name",
    "description": "Description",
    "permissions": "Permissions",
    "createRole": "Create role",
    "edit": "Edit",
    "deleteRole": "Delete role",
    "system": "System permission",
    "roleNameHelp": "Use lowercase letters, numbers and hyphens.",
    "refreshRoles": "Permission changes take effect after token refresh or the next sign-in.",
    "username": "Username",
    "searchUsers": "Search users (at least two characters)",
    "lastManager": "The last role administrator cannot be removed.",
    "action": "Action",
    "time": "Time",
    "outcome": "Outcome",
    "requestId": "Request ID",
    "degraded": "Live updates are unavailable. The current view refreshes through the service APIs.",
    "connection": "Connection",
    "connected": "Connected",
    "disconnected": "Disconnected",
    "locale": "Language",
    "welcome": "Sign in to manage your organization’s credentials.",
    "chain": "Resolve declared chain",
    "chainHelp": "Provide the root, chain and chainName descriptor supported by Storage.",
    "cancel": "Cancel",
    "noVerification": "No verification record is claimed for this credential.",
    "received": "Credential received; storage pending",
    "result": "Result",
    "offerQr": "Credential offer QR code",
    "copyOffer": "Copy credential offer",
    "given_name": "Given name",
    "family_name": "Family name",
    "organization": "Organization",
    "personal": "Personal OCM context",
    "disconnect": "Disconnect",
    "sort": "Sort by",
    "direction": "Direction",
    "newest": "Descending",
    "oldest": "Ascending",
    "all": "All",
    "pageSize": "Rows per page",
    "credentialId": "Credential ID",
    "issued": "Issued",
    "format": "Format",
    "download": "Download",
    "replacement": "Receive replacement",
    "revocationLimit": "Only the issuing authority can revoke a credential. This credential has no revocation entry managed by this OCM context.",
    "graphHelp": "Related credentials are joined by their declared issuer and holder identities. Open a DID link to inspect its document.",
    "graphUnverified": "These links describe credential declarations. They do not establish a verified chain of trust.",
    "identity": "Identity",
    "verificationSession": "Verification requested in this session; see the cryptographic and status results above.",
    "importCredential": "Import credential file",
    "importCredentialHelp": "Paste a downloaded JSON or compact JWT credential. Import stores it in the selected OCM context; verify it afterwards.",
    "credentialJson": "Credential JSON or JWT",
    "acceptedAwaitingStorage": "Retrieval accepted the request. This does not confirm persistence. Refresh Local credentials to check Storage separately.",
    "registry": "Credential registry",
    "registryHelp": "Manage credential type definitions for this organizational OCM context. Existing credentials are preserved when a type changes.",
    "configuredIssuer": "Configured issuer",
    "schema": "Credential schema",
    "shareOfferHelp": "Share this offer or QR code with the recipient’s OCM context. Each offer may be redeemed only once.",
    "clearingIntro": "Obtain a credential from a Clearing House, then receive its offer or import the downloaded credential into your OCM context. Lab credentials are for testing only.",
    "openProvider": "Open provider",
    "guide": "User guide",
    "requestCompliance": "Request compliance credential",
    "requestComplianceHelp": "Send your signed Verifiable Presentation to the selected provider through the Gaia-X Wizard. Production providers require valid onboarding and supporting credentials.",
    "signedVp": "Signed Verifiable Presentation",
    "alreadyHaveOffer": "Already have a credential offer?",
    "clearingImportHelp": "Receive an OID4VCI offer or import the downloaded credential. An administrator can approve the issuer host on the Connections page.",
    "credentialNotStored": "Credential received from the provider. Download or import it into the selected OCM context; storage has not been confirmed.",
    "test": "Test environment",
    "production": "Production",
    "directory": "Provider directory",
    "version": "Version",
    "eventMode": "Updates",
    "service": "Service",
    "lastSuccess": "Last successful request",
    "available": "Available",
    "unavailable": "Unavailable",
    "healthHelp": "This reports actual API requests. A ready pod alone does not prove that credential operations work.",
    "downloadEvidence": "Download health evidence",
    "menu": "Menu",
    "verifiedSuccessfully": "Credential verified successfully",
    "connections": "Connections",
    "endpoint_storage": "Storage URL",
    "endpoint_retrieval": "Retrieval URL",
    "endpoint_signer": "Signer URL",
    "endpoint_status": "Status List URL",
    "trustedConnections": "Trusted OCM context and issuer hosts",
    "trustedConnectionsHelp": "Add the hostnames you intend to exchange offers and relationship invitations with. One hostname per line. Your own OCM context is included automatically.",
    "trustedHosts": "Hostnames",
    "testConnection": "Test connection",
    "connectionTested": "Discovery and endpoint checks completed. Personal login is tested separately.",
    "connectionSaved": "Connection settings saved. Reconnect the personal OCM context to use them.",
    "clearingProvider": "Clearing House",
    "expired": "Expired",
    "verificationHistory": "Verification history",
    "nativeChain": "Native credential chain",
    "resolved": "Resolved",
    "unsupported-format": "Format not supported",
    "user": "User",
    "createUser": "Create user",
    "editUser": "Edit user",
    "deleteUser": "Delete user",
    "email": "Email",
    "firstName": "First name",
    "lastName": "Last name",
    "enabled": "Enabled",
    "disabled": "Disabled",
    "manageAccess": "Manage access",
    "effectivePermissions": "Effective permissions",
    "editRole": "Edit role",
    "permissionsHelp": "Permissions are fixed application actions. Combine them into roles, then assign roles to users.",
    "confirmDeleteUser": "Delete this user? Their existing credentials and audit history will remain.",
    "confirmDeleteRole": "Delete this role and remove its assignments?",
    "createType": "Create credential type",
    "editType": "Edit credential type",
    "deleteType": "Delete type",
    "identifier": "Identifier",
    "typeEditor": "Credential type editor",
    "issuerConfiguration": "Issuer configuration",
    "noIssuer": "No issuer linked",
    "registryIssuerHelp": "Link a native issuer configuration to enable issuance. Saving a type alone does not create an issuer template.",
    "confirmDeleteType": "Remove this type from the registry? Existing credentials and native issuer configuration will be preserved.",
    "claimFields": "Text claim fields",
    "addField": "Add field",
    "fieldName": "Field name",
    "required": "Required",
    "maxLength": "Maximum length",
    "connectionResults": "Connection test results",
    "connectionFailed": "Connection test failed. Review the checks below.",
    "connectionTestScope": "A reachable endpoint does not prove login or OCM context operations work. Save settings, connect your personal account, then test that account.",
    "check": "Check",
    "oidc": "Identity discovery",
    "pkce": "PKCE S256",
    "accountEndpoint": "Account endpoint",
    "personalLogin": "Personal authentication",
    "passed": "Passed",
    "partial": "Partial checks",
    "reachable": "Reachable",
    "authentication_required": "Reachable; login required",
    "not_tested": "Not tested",
    "keys": "Signing keys",
    "offers": "Credential offers",
    "lifecycleChecks": "Credential lifecycle checks",
    "confirmed": "Storage confirmed",
    "not_yet_confirmed": "Storage not yet confirmed",
    "offer_acceptance": "An issuance offer was created. The recipient must accept it before a stored credential can be checked.",
    "asynchronous_retrieval": "Retrieval is asynchronous. Refresh Local credentials after acceptance to inspect the stored credential.",
    "storage_readback": "Waiting for a permitted native storage read-back.",
    "lifecycleScope": "Availability checks do not verify a signature or perform revocation or deletion.",
    "checkAgain": "Check again",
    "reason": "Reason",
    "permissionGroup_credentials": "Credentials",
    "permissionGroup_relationships": "Relationships",
    "permissionGroup_roles": "Access management",
    "permissionGroup_audit": "Audit",
    "permissionGroup_system": "System",
    "permission_credentials.read": "Read credentials",
    "permission_credentials.verify": "Verify credentials",
    "permission_credentials.delete": "Delete local credentials",
    "permission_credentials.receive": "Receive credentials",
    "permission_credentials.issue": "Issue credentials and manage types",
    "permission_credentials.revoke": "Revoke owned credentials",
    "permission_relationships.read": "View relationships",
    "permission_relationships.write": "Manage relationships",
    "permission_audit.read": "Read audit history",
    "permission_roles.read": "View users, roles and permissions",
    "permission_admin.users": "Manage UI users and roles",
    "permission_system.health.read": "View system health",
    "temporaryPassword": "Temporary password",
    "temporaryPasswordHelp": "New users must change their temporary password at first login. No email is sent.",
    "API_HTTP_ERROR": "The server returned an HTTP error before a valid API response.",
    "API_INVALID_RESPONSE": "The server returned an invalid API response.",
    "INVALID_JSON_BODY": "The request body must be a valid JSON object.",
    "JSON_CONTENT_TYPE_REQUIRED": "Use application/json for this request.",
    "REQUEST_BODY_UNAVAILABLE": "The request body could not be read.",
    "REQUEST_TOO_LARGE": "The request is too large.",
    "acceptedStored": "Accepted and saved to Storage. The exact credential was confirmed by reading it back.",
    "RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED": "Retrieval cannot accept this credential format. Its current verifier supports JWT and SD-JWT; DeveloperCredential is issued as a JSON credential. The official Retrieval service needs support for this format.",
    "ACCEPTED_STORAGE_UNCONFIRMED": "Retrieval accepted the credential, but Storage persistence could not be confirmed. Do not accept the offer again.",
    "ACCEPTED_CREDENTIAL_RESPONSE_INVALID": "Retrieval accepted the offer without returning a usable credential. Storage persistence is unconfirmed; do not accept again.",
    "notDeclared": "Not declared",
    "not_separately_reported": "Not separately reported by the native service",
    "nativeVerdict": "This is the native Signer verdict. It does not return separate cryptographic and status results.",
    "nativeVerificationFailure": "The native service could not complete verification. This is not a valid or invalid verdict.",
    "statusHelp": "Status not checked means the native Status service has not confirmed this credential’s lifecycle state. It does not mean active or revoked. The reason appears beside each unchecked record.",
    "nativeRevokeConfirmed": "Revocation confirmed by the native Status service. The local copy is retained.",
    "requestedBy": "Requested by",
    "password": "Password",
    "changePassword": "Change password",
    "currentPassword": "Current password",
    "newPassword": "New password",
    "resetPassword": "New temporary password (optional)",
    "PASSWORD_POLICY": "Use at least 12 characters and at most 72 UTF-8 bytes, without control characters.",
    "PASSWORD_CHANGE_REQUIRED": "Change your temporary password to continue.",
    "PASSWORD_INCORRECT": "The current password is incorrect.",
    "CSRF_INVALID": "Reload this page and try again.",
    "LOGIN_RATE_LIMITED": "Too many sign-in attempts. Try again later.",
    "NATIVE_REFRESH_CONTRACT_UNVERIFIED": "The native credential refresh interface has not been verified.",
    "INVALID_VALIDITY_PERIOD": "Invalid validity period",
    "not_yet_valid": "Not yet valid",
    "suspended": "Suspended",
    "credential": "Credential",
    "nativeChainComposition": "Native chain composition (declarations)",
    "graphCycles": "Credential reference cycles",
    "graphTruncated": "The graph reached its documented size or depth limit.",
    "unresolvedReferences": "Unresolved references",
    "permission_clearing.request": "Request Clearing Center credentials",
    "clearingMissing": "Import the required VC 2.0 JWT credentials before requesting compliance.",
    "clearingConfirm": "Send the selected credentials to",
    "selectCredential": "Select a credential",
    "gaiax-legal-person": "Legal person (gx:LegalPerson)",
    "gaiax-vat-id": "VAT ID (gx:VatID)",
    "gaiax-terms-and-conditions": "Terms acceptance (gx:Issuer)",
    "clearingPhase_authorizing": "Checking the authorization request",
    "clearingPhase_presenting": "Submitting credentials for compliance",
    "clearingPhase_receiving": "Receiving the compliance credential",
    "clearingPhase_verifying": "Verifying the issuer signature",
    "clearingPhase_storing": "Storing the credential in OCM",
    "clearingPhase_complete": "Compliance credential stored",
    "clearingUnknown": "The exchange was interrupted. Check the provider outcome before starting another request.",
    "clearingStored": "Stored credential",
    "clearingStore": "Retry storage",
    "CLEARING_HTTP_REJECTED": "The provider rejected the request.",
    "CLEARING_CONNECTION_FAILED": "The provider could not be reached.",
    "CLEARING_TIMEOUT": "The provider did not respond within the request timeout.",
    "requestCredential": "Request credential"
  },
  "de": {
    "copyInvitation": "Einladungs-URL kopieren",
    "inspectOperation": "Vorgang prüfen",
    "app": "OCM W-Stack",
    "subtitle": "Organisationsnachweise",
    "login": "Anmelden",
    "logout": "Abmelden",
    "credentials": "Lokale Nachweise",
    "receive": "Nachweis empfangen",
    "issue": "Nachweis ausstellen",
    "relationships": "Beziehungen",
    "roles": "Rollen",
    "assignments": "Benutzer",
    "audit": "Audit-Protokoll",
    "health": "Dienststatus",
    "refresh": "Aktualisieren",
    "loading": "Wird geladen…",
    "empty": "Keine Einträge gefunden.",
    "error": "Die Anfrage konnte nicht abgeschlossen werden.",
    "forbidden": "Sie haben keine Berechtigung für diese Aktion.",
    "search": "Suchen",
    "type": "Typ",
    "issuer": "Aussteller",
    "holder": "Inhaber",
    "verifier": "Prüfer",
    "id": "Kennung",
    "status": "Status",
    "expires": "Gültig bis",
    "view": "Anzeigen",
    "verify": "Prüfen",
    "revoke": "Widerrufen",
    "delete": "Lokale Kopie löschen",
    "confirmRevoke": "Diesen Nachweis widerrufen? Der Status wird geändert. Dies kann unumkehrbar sein.",
    "confirmDelete": "Lokale Kopie löschen? Der Nachweis wird dadurch nicht widerrufen.",
    "confirm": "Diese Änderung anwenden?",
    "close": "Schließen",
    "claims": "Angaben im Nachweis",
    "raw": "Rohdaten anzeigen",
    "provenance": "Herkunft",
    "declarations": "Angaben aus dem Nachweis; die Prüfung wird separat angezeigt.",
    "unknown": "Unbekannt",
    "not_checked": "Nicht geprüft",
    "valid": "Gültig",
    "invalid": "Ungültig",
    "indeterminate": "Unbestimmt",
    "unsupported": "Nicht unterstützt",
    "active": "Aktiv",
    "revoked": "Widerrufen",
    "not_required": "Nicht erforderlich",
    "cryptographic": "Kryptografische Prüfung",
    "overall": "Gesamtergebnis",
    "checkedAt": "Geprüft am",
    "total": "Passende Nachweise insgesamt",
    "next": "Nächste Seite",
    "back": "Erste Seite",
    "updated": "Zuletzt aktualisiert",
    "offer": "Nachweisangebot",
    "offerHelp": "Fügen Sie ein OID4VCI-Angebot vom Clearing Center oder einem anderen zugelassenen Aussteller ein.",
    "import": "Angebot importieren",
    "accept": "Annehmen",
    "reject": "Ablehnen",
    "txCode": "Transaktionscode (falls erforderlich)",
    "pendingOffers": "Ausstehende Angebote",
    "clearing": "Gaia-X Clearing Center",
    "clearingHelp": "Wählen Sie die drei signierten Gaia-X-Nachweise für die Loire-Konformitätsprüfung.",
    "demo": "Demo-Ausstellung",
    "demoHelp": "Das konfigurierte Inhalts-Plugin erstellt das Angebot. Der echte Signer signiert kryptografisch.",
    "review": "Prüfen und ausstellen",
    "offerResult": "Angebot zum Teilen bereit",
    "copy": "Kopieren",
    "copied": "Kopiert",
    "succeeded": "Abgeschlossen",
    "dispatching": "In Bearbeitung",
    "outcomeUnknown": "Das Ergebnis ist unklar. Nicht mit einem neuen Schlüssel erneut senden; prüfen Sie zuerst den Vorgang.",
    "label": "Bezeichnung",
    "did": "Partner-DID",
    "invitation": "Einladung",
    "createInvitation": "Einladung erstellen",
    "acceptInvitation": "Einladung annehmen",
    "block": "Sperren",
    "unblock": "Entsperren",
    "remove": "Beziehung entfernen",
    "save": "Speichern",
    "name": "Name",
    "description": "Beschreibung",
    "permissions": "Berechtigungen",
    "createRole": "Rolle erstellen",
    "edit": "Bearbeiten",
    "deleteRole": "Rolle löschen",
    "system": "Systemberechtigung",
    "roleNameHelp": "Verwenden Sie Kleinbuchstaben, Zahlen und Bindestriche.",
    "refreshRoles": "Berechtigungsänderungen werden nach Token-Aktualisierung oder erneuter Anmeldung wirksam.",
    "username": "Benutzername",
    "searchUsers": "Benutzer suchen (mindestens zwei Zeichen)",
    "lastManager": "Der letzte Rollenadministrator kann nicht entfernt werden.",
    "action": "Aktion",
    "time": "Zeit",
    "outcome": "Ergebnis",
    "requestId": "Anfrage-ID",
    "degraded": "Live-Aktualisierungen sind nicht verfügbar. Die Ansicht wird über die Dienst-APIs aktualisiert.",
    "connection": "Verbindung",
    "connected": "Verbunden",
    "disconnected": "Getrennt",
    "locale": "Sprache",
    "welcome": "Melden Sie sich an, um die Nachweise Ihrer Organisation zu verwalten.",
    "chain": "Deklarierte Kette auflösen",
    "chainHelp": "Geben Sie den von Storage unterstützten Deskriptor mit root, chain und chainName an.",
    "cancel": "Abbrechen",
    "noVerification": "Für diesen Nachweis liegt hier kein bestätigter Prüfnachweis vor.",
    "received": "Nachweis empfangen; Speicherung ausstehend",
    "result": "Ergebnis",
    "offerQr": "QR-Code des Credential-Angebots",
    "copyOffer": "Credential-Angebot kopieren",
    "given_name": "Vorname",
    "family_name": "Nachname",
    "organization": "Organisation",
    "personal": "Persönliches OCM-Bereich",
    "disconnect": "Trennen",
    "sort": "Sortieren nach",
    "direction": "Richtung",
    "newest": "Absteigend",
    "oldest": "Aufsteigend",
    "all": "Alle",
    "pageSize": "Zeilen pro Seite",
    "credentialId": "Nachweis-ID",
    "issued": "Ausgestellt",
    "format": "Format",
    "download": "Herunterladen",
    "replacement": "Ersatz empfangen",
    "revocationLimit": "Nur die ausstellende Stelle kann einen Nachweis widerrufen. Dieser Nachweis hat keinen von diesem OCM-Bereich verwalteten Widerrufseintrag.",
    "graphHelp": "Verwandte Nachweise werden anhand ihrer angegebenen Aussteller- und Inhaberidentitäten verknüpft. Öffnen Sie einen DID-Link, um das Dokument zu prüfen.",
    "graphUnverified": "Diese Verknüpfungen zeigen Angaben aus Nachweisen und bestätigen keine geprüfte Vertrauenskette.",
    "identity": "Identität",
    "verificationSession": "Prüfung in dieser Sitzung angefordert; kryptografisches Ergebnis und Status stehen oben.",
    "importCredential": "Nachweis importieren",
    "importCredentialHelp": "Fügen Sie einen heruntergeladenen JSON- oder JWT-Nachweis ein. Nach dem Speichern im gewählten OCM-Bereich sollte er geprüft werden.",
    "credentialJson": "Nachweis als JSON oder JWT",
    "acceptedAwaitingStorage": "Retrieval hat die Anfrage angenommen. Die Speicherung ist noch nicht bestätigt. Aktualisieren Sie die lokalen Nachweise, um Storage gesondert zu prüfen.",
    "registry": "Nachweisregister",
    "registryHelp": "Verwalten Sie Nachweistypen dieser OCM-Organisationsbereich. Bestehende Nachweise bleiben bei Änderungen erhalten.",
    "configuredIssuer": "Konfigurierter Aussteller",
    "schema": "Nachweisschema",
    "shareOfferHelp": "Teilen Sie dieses Angebot oder den QR-Code mit dem OCM-Bereich des Empfängers. Jedes Angebot kann nur einmal eingelöst werden.",
    "clearingIntro": "Beziehen Sie einen Nachweis von einem Clearing House und empfangen Sie dessen Angebot oder importieren Sie den heruntergeladenen Nachweis. Lab-Nachweise dienen nur Tests.",
    "openProvider": "Anbieter öffnen",
    "guide": "Anleitung",
    "requestCompliance": "Compliance-Nachweis anfordern",
    "requestComplianceHelp": "Senden Sie Ihre signierte Verifiable Presentation über den Gaia-X Wizard an den gewählten Anbieter. Produktive Anbieter benötigen gültiges Onboarding und die erforderlichen Nachweise.",
    "signedVp": "Signierte Verifiable Presentation",
    "alreadyHaveOffer": "Bereits ein Nachweisangebot vorhanden?",
    "clearingImportHelp": "Empfangen Sie ein OID4VCI-Angebot oder importieren Sie den Nachweis. Administratoren können den Aussteller-Host unter Verbindungen freigeben.",
    "credentialNotStored": "Nachweis vom Anbieter empfangen. Laden Sie ihn herunter oder importieren Sie ihn in die gewählte OCM-Bereich. Die Speicherung ist noch nicht bestätigt.",
    "test": "Testumgebung",
    "production": "Produktion",
    "directory": "Anbieterverzeichnis",
    "version": "Version",
    "eventMode": "Aktualisierungen",
    "service": "Dienst",
    "lastSuccess": "Letzte erfolgreiche Anfrage",
    "available": "Verfügbar",
    "unavailable": "Nicht verfügbar",
    "healthHelp": "Dieser Bericht zeigt tatsächliche API-Anfragen. Ein bereiter Pod allein bestätigt keine funktionierenden Nachweisaktionen.",
    "downloadEvidence": "Statusnachweis herunterladen",
    "menu": "Menü",
    "verifiedSuccessfully": "Nachweis erfolgreich geprüft",
    "connections": "Verbindungen",
    "endpoint_storage": "Storage-URL",
    "endpoint_retrieval": "Retrieval-URL",
    "endpoint_signer": "Signer-URL",
    "endpoint_status": "Statuslisten-URL",
    "trustedConnections": "Vertrauenswürdige OCM-Bereich- und Issuer-Hosts",
    "trustedConnectionsHelp": "Tragen Sie die Hostnamen für den Austausch von Angeboten und Beziehungseinladungen ein. Ein Hostname pro Zeile. Das eigene OCM-Bereich ist automatisch enthalten.",
    "trustedHosts": "Hostnamen",
    "testConnection": "Verbindung testen",
    "connectionTested": "Erkennung und Endpunktprüfungen abgeschlossen. Die persönliche Anmeldung wird separat geprüft.",
    "connectionSaved": "Verbindungseinstellungen gespeichert. Verbinden Sie das persönliche OCM-Bereich erneut.",
    "clearingProvider": "Clearing House",
    "expired": "Abgelaufen",
    "verificationHistory": "Prüfverlauf",
    "nativeChain": "Native Credential-Kette",
    "resolved": "Aufgelöst",
    "unsupported-format": "Format nicht unterstützt",
    "user": "Benutzer",
    "createUser": "Benutzer erstellen",
    "editUser": "Benutzer bearbeiten",
    "deleteUser": "Benutzer löschen",
    "email": "E-Mail",
    "firstName": "Vorname",
    "lastName": "Nachname",
    "enabled": "Aktiviert",
    "disabled": "Deaktiviert",
    "manageAccess": "Zugriff verwalten",
    "effectivePermissions": "Effektive Berechtigungen",
    "editRole": "Rolle bearbeiten",
    "permissionsHelp": "Berechtigungen sind feste Anwendungsaktionen. Fassen Sie sie zu Rollen zusammen und weisen Sie diese Benutzern zu.",
    "confirmDeleteUser": "Diesen Benutzer löschen? Vorhandene Nachweise und Audit-Einträge bleiben erhalten.",
    "confirmDeleteRole": "Diese Rolle und ihre Zuweisungen löschen ?",
    "createType": "Nachweistyp erstellen",
    "editType": "Nachweistyp bearbeiten",
    "deleteType": "Typ löschen",
    "identifier": "Kennung",
    "typeEditor": "Editor für Nachweistypen",
    "issuerConfiguration": "Ausstellerkonfiguration",
    "noIssuer": "Kein Aussteller verknüpft",
    "registryIssuerHelp": "Verknüpfen Sie eine native Ausstellerkonfiguration, um die Ausstellung zu aktivieren. Ein gespeicherter Typ erstellt keine Ausstellervorlage.",
    "confirmDeleteType": "Diesen Typ aus dem Register entfernen? Vorhandene Nachweise und die native Ausstellerkonfiguration bleiben erhalten.",
    "claimFields": "Textfelder des Nachweises",
    "addField": "Feld hinzufügen",
    "fieldName": "Feldname",
    "required": "Erforderlich",
    "maxLength": "Maximale Länge",
    "connectionResults": "Ergebnisse des Verbindungstests",
    "connectionFailed": "Verbindungstest fehlgeschlagen. Prüfen Sie die Ergebnisse.",
    "connectionTestScope": "Ein erreichbarer Endpunkt bestätigt weder Anmeldung noch OCM-Bereich-Funktionen. Speichern Sie, verbinden Sie Ihr persönliches Konto und testen Sie es.",
    "check": "Prüfung",
    "oidc": "Identitätserkennung",
    "pkce": "PKCE S256",
    "accountEndpoint": "Konto-Endpunkt",
    "personalLogin": "Persönliche Anmeldung",
    "passed": "Bestanden",
    "partial": "Teilweise geprüft",
    "reachable": "Erreichbar",
    "authentication_required": "Erreichbar; Anmeldung erforderlich",
    "not_tested": "Nicht geprüft",
    "keys": "Signaturschlüssel",
    "offers": "Nachweisangebote",
    "lifecycleChecks": "Prüfung des Nachweislebenszyklus",
    "confirmed": "Speicherung bestätigt",
    "not_yet_confirmed": "Speicherung noch nicht bestätigt",
    "offer_acceptance": "Ein Ausstellungsangebot wurde erstellt. Nach Annahme kann der gespeicherte Nachweis geprüft werden.",
    "asynchronous_retrieval": "Der Abruf erfolgt asynchron. Aktualisieren Sie nach Annahme die lokalen Nachweise.",
    "storage_readback": "Warten auf erlaubtes Lesen aus dem nativen Speicher.",
    "lifecycleScope": "Verfügbarkeitsprüfungen prüfen keine Signatur und widerrufen oder löschen nichts.",
    "checkAgain": "Erneut prüfen",
    "reason": "Grund",
    "permissionGroup_credentials": "Nachweise",
    "permissionGroup_relationships": "Beziehungen",
    "permissionGroup_roles": "Zugriffsverwaltung",
    "permissionGroup_audit": "Audit",
    "permissionGroup_system": "System",
    "permission_credentials.read": "Nachweise lesen",
    "permission_credentials.verify": "Nachweise prüfen",
    "permission_credentials.delete": "Lokale Nachweise löschen",
    "permission_credentials.receive": "Nachweise empfangen",
    "permission_credentials.issue": "Nachweise ausstellen und Typen verwalten",
    "permission_credentials.revoke": "Eigene Nachweise widerrufen",
    "permission_relationships.read": "Beziehungen ansehen",
    "permission_relationships.write": "Beziehungen verwalten",
    "permission_audit.read": "Audit-Verlauf lesen",
    "permission_roles.read": "Benutzer, Rollen und Rechte ansehen",
    "permission_admin.users": "UI-Benutzer und Rollen verwalten",
    "permission_system.health.read": "Systemzustand ansehen",
    "temporaryPassword": "Temporäres Passwort",
    "temporaryPasswordHelp": "Neue Benutzer müssen ihr temporäres Passwort bei der ersten Anmeldung ändern. Es wird keine E-Mail versendet.",
    "API_HTTP_ERROR": "Der Server hat einen HTTP-Fehler statt einer gültigen API-Antwort zurückgegeben.",
    "API_INVALID_RESPONSE": "Die API-Antwort des Servers ist ungültig.",
    "INVALID_JSON_BODY": "Die Anfrage muss ein gültiges JSON-Objekt enthalten.",
    "acceptedStored": "Angenommen und in Storage gespeichert. Der genaue Nachweis wurde durch erneutes Lesen bestätigt.",
    "RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED": "Retrieval unterstützt dieses Nachweisformat nicht. Die Prüfung akzeptiert derzeit JWT und SD-JWT; DeveloperCredential wird als JSON-Nachweis ausgestellt. Der offizielle Retrieval-Dienst benötigt Unterstützung für dieses Format.",
    "ACCEPTED_STORAGE_UNCONFIRMED": "Retrieval hat den Nachweis angenommen, aber die Speicherung konnte nicht bestätigt werden. Nehmen Sie das Angebot nicht erneut an.",
    "ACCEPTED_CREDENTIAL_RESPONSE_INVALID": "Retrieval hat das Angebot ohne verwendbaren Nachweis angenommen. Die Speicherung ist unbestätigt; nicht erneut annehmen.",
    "notDeclared": "Nicht angegeben",
    "not_separately_reported": "Vom nativen Dienst nicht separat gemeldet",
    "nativeVerdict": "Dies ist das Ergebnis des nativen Signer-Dienstes. Kryptografie und Status werden nicht separat gemeldet.",
    "nativeVerificationFailure": "Der native Dienst konnte die Prüfung nicht abschließen. Dies ist kein Gültigkeitsurteil.",
    "statusHelp": "Status nicht geprüft bedeutet, dass der native Status-Dienst den Lebenszyklusstatus nicht bestätigt hat. Der Grund steht beim Eintrag.",
    "nativeRevokeConfirmed": "Widerruf vom nativen Status-Dienst bestätigt. Die lokale Kopie bleibt erhalten.",
    "requestedBy": "Angefordert von",
    "JSON_CONTENT_TYPE_REQUIRED": "Verwenden Sie application/json für diese Anfrage.",
    "REQUEST_BODY_UNAVAILABLE": "Der Anfrageinhalt konnte nicht gelesen werden.",
    "REQUEST_TOO_LARGE": "Die Anfrage ist zu groß.",
    "password": "Passwort",
    "changePassword": "Passwort ändern",
    "currentPassword": "Aktuelles Passwort",
    "newPassword": "Neues Passwort",
    "resetPassword": "Neues vorläufiges Passwort (optional)",
    "PASSWORD_POLICY": "Verwenden Sie mindestens 12 Zeichen und höchstens 72 UTF-8-Bytes, ohne Steuerzeichen.",
    "PASSWORD_CHANGE_REQUIRED": "Ändern Sie Ihr vorläufiges Passwort, um fortzufahren.",
    "PASSWORD_INCORRECT": "Das aktuelle Passwort ist falsch.",
    "CSRF_INVALID": "Laden Sie die Seite neu und versuchen Sie es erneut.",
    "LOGIN_RATE_LIMITED": "Zu viele Anmeldeversuche. Versuchen Sie es später erneut.",
    "NATIVE_REFRESH_CONTRACT_UNVERIFIED": "Die native Schnittstelle zur Nachweiserneuerung wurde noch nicht geprüft.",
    "INVALID_VALIDITY_PERIOD": "Ungültiger Gültigkeitszeitraum",
    "not_yet_valid": "Noch nicht gültig",
    "suspended": "Ausgesetzt",
    "credential": "Nachweis",
    "nativeChainComposition": "Native Kettenzusammenstellung (Angaben)",
    "graphCycles": "Zyklen in Nachweisreferenzen",
    "graphTruncated": "Der Graph hat die dokumentierte Größen- oder Tiefengrenze erreicht.",
    "unresolvedReferences": "Nicht aufgelöste Referenzen",
    "permission_clearing.request": "Nachweise beim Clearing Center anfordern",
    "clearingMissing": "Importieren Sie zuerst die erforderlichen VC-2.0-JWT-Nachweise.",
    "clearingConfirm": "Ausgewählte Nachweise senden an",
    "selectCredential": "Nachweis auswählen",
    "gaiax-legal-person": "Juristische Person (gx:LegalPerson)",
    "gaiax-vat-id": "Umsatzsteuer-ID (gx:VatID)",
    "gaiax-terms-and-conditions": "Annahme der Bedingungen (gx:Issuer)",
    "clearingPhase_authorizing": "Autorisierungsanfrage prüfen",
    "clearingPhase_presenting": "Nachweise zur Konformitätsprüfung senden",
    "clearingPhase_receiving": "Konformitätsnachweis empfangen",
    "clearingPhase_verifying": "Signatur des Ausstellers prüfen",
    "clearingPhase_storing": "Nachweis in OCM speichern",
    "clearingPhase_complete": "Konformitätsnachweis gespeichert",
    "clearingUnknown": "Der Austausch wurde unterbrochen. Prüfen Sie das Ergebnis beim Anbieter vor einer neuen Anfrage.",
    "clearingStored": "Gespeicherter Nachweis",
    "clearingStore": "Speichern erneut versuchen",
    "CLEARING_HTTP_REJECTED": "Der Anbieter hat die Anfrage abgelehnt.",
    "CLEARING_CONNECTION_FAILED": "Der Anbieter ist nicht erreichbar.",
    "CLEARING_TIMEOUT": "Der Anbieter hat nicht rechtzeitig geantwortet.",
    "requestCredential": "Nachweis anfordern"
  },
  "fr": {
    "copyInvitation": "Copier le lien d’invitation",
    "inspectOperation": "Vérifier l’opération",
    "app": "OCM W-Stack",
    "subtitle": "Justificatifs de l’organisation",
    "login": "Se connecter",
    "logout": "Se déconnecter",
    "credentials": "Justificatifs locaux",
    "receive": "Recevoir un justificatif",
    "issue": "Émettre un justificatif",
    "relationships": "Relations",
    "roles": "Rôles",
    "assignments": "Utilisateurs",
    "audit": "Journal d’audit",
    "health": "État des services",
    "refresh": "Actualiser",
    "loading": "Chargement…",
    "empty": "Aucun enregistrement trouvé.",
    "error": "La requête n’a pas pu être exécutée.",
    "forbidden": "Vous n’avez pas l’autorisation d’effectuer cette action.",
    "search": "Rechercher",
    "type": "Type",
    "issuer": "Émetteur",
    "holder": "Titulaire",
    "verifier": "Vérificateur",
    "id": "Identifiant",
    "status": "État",
    "expires": "Expiration",
    "view": "Consulter",
    "verify": "Vérifier",
    "revoke": "Révoquer",
    "delete": "Supprimer la copie locale",
    "confirmRevoke": "Révoquer ce justificatif ? Son statut sera modifié et cette opération peut être irréversible.",
    "confirmDelete": "Supprimer la copie locale ? Cette action ne révoque pas le justificatif.",
    "confirm": "Appliquer cette modification ?",
    "close": "Fermer",
    "claims": "Attributs du justificatif",
    "raw": "Afficher le justificatif brut",
    "provenance": "Provenance",
    "declarations": "Déclarations du justificatif ; la vérification est présentée séparément.",
    "unknown": "Inconnu",
    "not_checked": "Non vérifié",
    "valid": "Valide",
    "invalid": "Invalide",
    "indeterminate": "Indéterminé",
    "unsupported": "Non pris en charge",
    "active": "Actif",
    "revoked": "Révoqué",
    "not_required": "Non requis",
    "cryptographic": "Vérification cryptographique",
    "overall": "Résultat global",
    "checkedAt": "Vérifié le",
    "total": "Total des justificatifs correspondants",
    "next": "Page suivante",
    "back": "Première page",
    "updated": "Dernière actualisation",
    "offer": "Offre de justificatif",
    "offerHelp": "Collez une offre OID4VCI du Clearing Center ou d’un autre émetteur autorisé.",
    "import": "Importer l’offre",
    "accept": "Accepter",
    "reject": "Refuser",
    "txCode": "Code de transaction (si nécessaire)",
    "pendingOffers": "Offres en attente",
    "clearing": "Gaia-X Clearing Center",
    "clearingHelp": "Sélectionnez les trois justificatifs Gaia-X signés pour la conformité Loire.",
    "demo": "Émission de démonstration",
    "demoHelp": "Le module de contenu configuré prépare l’offre. Le véritable service Signer effectue la signature cryptographique.",
    "review": "Vérifier et émettre",
    "offerResult": "Offre prête à partager",
    "copy": "Copier",
    "copied": "Copié",
    "succeeded": "Terminé",
    "dispatching": "Traitement en cours",
    "outcomeUnknown": "Le résultat est inconnu. Ne renvoyez pas la demande avec une nouvelle clé ; vérifiez d’abord l’opération.",
    "label": "Libellé",
    "did": "DID du partenaire",
    "invitation": "Invitation",
    "createInvitation": "Créer une invitation",
    "acceptInvitation": "Accepter une invitation",
    "block": "Bloquer",
    "unblock": "Débloquer",
    "remove": "Supprimer la relation",
    "save": "Enregistrer",
    "name": "Nom",
    "description": "Description",
    "permissions": "Autorisations",
    "createRole": "Créer un rôle",
    "edit": "Modifier",
    "deleteRole": "Supprimer le rôle",
    "system": "Autorisation système",
    "roleNameHelp": "Utilisez des lettres minuscules, chiffres et tirets.",
    "refreshRoles": "Les modifications prennent effet après l’actualisation du jeton ou la prochaine connexion.",
    "username": "Nom d’utilisateur",
    "searchUsers": "Rechercher des utilisateurs (au moins deux caractères)",
    "lastManager": "Le dernier administrateur des rôles ne peut pas être supprimé.",
    "action": "Action",
    "time": "Heure",
    "outcome": "Résultat",
    "requestId": "Identifiant de requête",
    "degraded": "Les mises à jour en direct sont indisponibles. La vue est actualisée via les API des services.",
    "connection": "Connexion",
    "connected": "Connecté",
    "disconnected": "Déconnecté",
    "locale": "Langue",
    "welcome": "Connectez-vous pour gérer les justificatifs de votre organisation.",
    "chain": "Résoudre la chaîne déclarée",
    "chainHelp": "Fournissez le descripteur root, chain et chainName pris en charge par Storage.",
    "cancel": "Annuler",
    "noVerification": "Aucun historique de vérification n’est revendiqué pour ce justificatif.",
    "received": "Justificatif reçu ; enregistrement en attente",
    "result": "Résultat",
    "offerQr": "Code QR de l’offre d’attestation",
    "copyOffer": "Copier l’offre d’attestation",
    "given_name": "Prénom",
    "family_name": "Nom",
    "organization": "Organisation",
    "personal": "Portefeuille personnel",
    "disconnect": "Déconnecter",
    "sort": "Trier par",
    "direction": "Direction",
    "newest": "Décroissant",
    "oldest": "Croissant",
    "all": "Tous",
    "pageSize": "Lignes par page",
    "credentialId": "Identifiant du justificatif",
    "issued": "Émis",
    "format": "Format",
    "download": "Télécharger",
    "replacement": "Recevoir un remplacement",
    "revocationLimit": "Seule l’autorité émettrice peut révoquer un justificatif. Ce justificatif ne possède aucune entrée de révocation gérée par ce portefeuille.",
    "graphHelp": "Les justificatifs sont reliés par leurs identités déclarées d’émetteur et de titulaire. Ouvrez un lien DID pour consulter son document.",
    "graphUnverified": "Ces liens décrivent les déclarations des justificatifs. Ils ne prouvent pas une chaîne de confiance vérifiée.",
    "identity": "Identité",
    "verificationSession": "Vérification demandée pendant cette session ; consultez les résultats cryptographiques et le statut ci-dessus.",
    "importCredential": "Importer un justificatif",
    "importCredentialHelp": "Collez un justificatif JSON ou JWT téléchargé. L’importation le stocke dans le portefeuille sélectionné ; vérifiez-le ensuite.",
    "credentialJson": "Justificatif JSON ou JWT",
    "acceptedAwaitingStorage": "Retrieval a accepté la demande. Le stockage n’est pas encore confirmé. Actualisez les justificatifs locaux pour vérifier Storage séparément.",
    "registry": "Registre des justificatifs",
    "registryHelp": "Gérez les types de cette identité organisationnelle. Les justificatifs existants sont conservés lors des modifications.",
    "configuredIssuer": "Émetteur configuré",
    "schema": "Schéma du justificatif",
    "shareOfferHelp": "Partagez cette offre ou ce code QR avec le portefeuille du destinataire. Chaque offre ne peut être utilisée qu’une fois.",
    "clearingIntro": "Obtenez un justificatif auprès d’une Clearing House, puis recevez son offre ou importez le justificatif téléchargé. Les justificatifs de laboratoire servent uniquement aux tests.",
    "openProvider": "Ouvrir le fournisseur",
    "guide": "Guide utilisateur",
    "requestCompliance": "Demander une attestation de conformité",
    "requestComplianceHelp": "Envoyez votre présentation vérifiable signée au prestataire sélectionné via Gaia-X Wizard. Les prestataires de production exigent une inscription valide et les justificatifs nécessaires.",
    "signedVp": "Présentation vérifiable signée",
    "alreadyHaveOffer": "Vous avez déjà une offre ?",
    "clearingImportHelp": "Recevez une offre OID4VCI ou importez l’attestation téléchargée. Un administrateur peut autoriser l’hôte émetteur dans Connexions.",
    "credentialNotStored": "Attestation reçue du prestataire. Téléchargez-la ou importez-la dans le portefeuille sélectionné ; son stockage n’est pas confirmé.",
    "test": "Environnement de test",
    "production": "Production",
    "directory": "Annuaire des fournisseurs",
    "version": "Version",
    "eventMode": "Actualisations",
    "service": "Service",
    "lastSuccess": "Dernière requête réussie",
    "available": "Disponible",
    "unavailable": "Indisponible",
    "healthHelp": "Ce rapport reflète les requêtes API réelles. Un pod prêt ne prouve pas que les opérations fonctionnent.",
    "downloadEvidence": "Télécharger le rapport de santé",
    "menu": "Menu",
    "verifiedSuccessfully": "Justificatif vérifié avec succès",
    "connections": "Connexions",
    "endpoint_storage": "URL de stockage",
    "endpoint_retrieval": "URL de réception",
    "endpoint_signer": "URL du signataire",
    "endpoint_status": "URL de liste de statut",
    "trustedConnections": "Hôtes de portefeuilles et d’émetteurs approuvés",
    "trustedConnectionsHelp": "Ajoutez les noms d’hôte avec lesquels vous échangez des offres et des invitations. Un hôte par ligne. Votre portefeuille est inclus automatiquement.",
    "trustedHosts": "Noms d’hôte",
    "testConnection": "Tester la connexion",
    "connectionTested": "Vérifications de découverte et du service terminées. La connexion personnelle est testée séparément.",
    "connectionSaved": "Paramètres enregistrés. Reconnectez le portefeuille personnel pour les utiliser.",
    "clearingProvider": "Chambre de compensation",
    "expired": "Expiré",
    "verificationHistory": "Historique des vérifications",
    "nativeChain": "Chaîne native des justificatifs",
    "resolved": "Résolue",
    "unsupported-format": "Format non pris en charge",
    "user": "Utilisateur",
    "createUser": "Créer un utilisateur",
    "editUser": "Modifier l’utilisateur",
    "deleteUser": "Supprimer l’utilisateur",
    "email": "E-mail",
    "firstName": "Prénom",
    "lastName": "Nom",
    "enabled": "Activé",
    "disabled": "Désactivé",
    "manageAccess": "Gérer les accès",
    "effectivePermissions": "Autorisations effectives",
    "editRole": "Modifier le rôle",
    "permissionsHelp": "Les autorisations correspondent aux actions de l’application. Regroupez-les en rôles, puis attribuez ces rôles aux utilisateurs.",
    "confirmDeleteUser": "Supprimer cet utilisateur ? Ses justificatifs et son historique d’audit seront conservés.",
    "confirmDeleteRole": "Supprimer ce rôle et ses attributions ?",
    "createType": "Créer un type de justificatif",
    "editType": "Modifier le type de justificatif",
    "deleteType": "Supprimer le type",
    "identifier": "Identifiant",
    "typeEditor": "Éditeur de types de justificatifs",
    "issuerConfiguration": "Configuration de l’émetteur",
    "noIssuer": "Aucun émetteur associé",
    "registryIssuerHelp": "Associez une configuration native pour permettre l’émission. Enregistrer un type ne crée pas de modèle d’émetteur.",
    "confirmDeleteType": "Retirer ce type du registre ? Les justificatifs et la configuration native seront conservés.",
    "claimFields": "Champs textuels du justificatif",
    "addField": "Ajouter un champ",
    "fieldName": "Nom du champ",
    "required": "Obligatoire",
    "maxLength": "Longueur maximale",
    "connectionResults": "Résultats du test de connexion",
    "connectionFailed": "Échec du test de connexion. Consultez les résultats.",
    "connectionTestScope": "Un service joignable ne prouve pas le fonctionnement de l’authentification. Enregistrez, connectez votre compte personnel, puis testez-le.",
    "check": "Vérification",
    "oidc": "Découverte d’identité",
    "pkce": "PKCE S256",
    "accountEndpoint": "Service de compte",
    "personalLogin": "Authentification personnelle",
    "passed": "Réussi",
    "partial": "Vérifications partielles",
    "reachable": "Joignable",
    "authentication_required": "Joignable ; connexion requise",
    "not_tested": "Non testé",
    "keys": "Clés de signature",
    "offers": "Offres de justificatifs",
    "lifecycleChecks": "Vérification du cycle de vie",
    "confirmed": "Stockage confirmé",
    "not_yet_confirmed": "Stockage non encore confirmé",
    "offer_acceptance": "Une offre a été créée. Le destinataire doit l’accepter avant la vérification du justificatif stocké.",
    "asynchronous_retrieval": "La réception est asynchrone. Actualisez les justificatifs locaux après acceptation.",
    "storage_readback": "En attente d’une lecture autorisée du stockage natif.",
    "lifecycleScope": "Ces contrôles ne vérifient pas la signature et ne révoquent ni ne suppriment rien.",
    "checkAgain": "Vérifier à nouveau",
    "reason": "Motif",
    "permissionGroup_credentials": "Justificatifs",
    "permissionGroup_relationships": "Relations",
    "permissionGroup_roles": "Gestion des accès",
    "permissionGroup_audit": "Audit",
    "permissionGroup_system": "Système",
    "permission_credentials.read": "Lire les justificatifs",
    "permission_credentials.verify": "Vérifier les justificatifs",
    "permission_credentials.delete": "Supprimer les justificatifs locaux",
    "permission_credentials.receive": "Recevoir des justificatifs",
    "permission_credentials.issue": "Émettre et gérer les types",
    "permission_credentials.revoke": "Révoquer ses justificatifs",
    "permission_relationships.read": "Voir les relations",
    "permission_relationships.write": "Gérer les relations",
    "permission_audit.read": "Lire l’historique d’audit",
    "permission_roles.read": "Voir utilisateurs, rôles et autorisations",
    "permission_admin.users": "Gérer les utilisateurs et rôles de l’interface",
    "permission_system.health.read": "Voir l’état du système",
    "temporaryPassword": "Mot de passe temporaire",
    "temporaryPasswordHelp": "Les nouveaux utilisateurs doivent changer leur mot de passe à la première connexion. Aucun e-mail n’est envoyé.",
    "API_HTTP_ERROR": "Le serveur a renvoyé une erreur HTTP au lieu d’une réponse API valide.",
    "API_INVALID_RESPONSE": "La réponse API du serveur est invalide.",
    "INVALID_JSON_BODY": "La requête doit contenir un objet JSON valide.",
    "acceptedStored": "Accepté et enregistré dans Storage. Le justificatif exact a été confirmé par une nouvelle lecture.",
    "RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED": "Retrieval ne prend pas en charge ce format. Son vérificateur accepte actuellement JWT et SD-JWT ; DeveloperCredential est émis en JSON. Le service Retrieval officiel doit prendre en charge ce format.",
    "ACCEPTED_STORAGE_UNCONFIRMED": "Retrieval a accepté le justificatif, mais son stockage n’a pas été confirmé. N’acceptez pas à nouveau l’offre.",
    "ACCEPTED_CREDENTIAL_RESPONSE_INVALID": "Retrieval a accepté l’offre sans renvoyer de justificatif utilisable. Le stockage reste non confirmé ; ne l’acceptez pas à nouveau.",
    "notDeclared": "Non déclaré",
    "not_separately_reported": "Non rapporté séparément par le service natif",
    "nativeVerdict": "Résultat du service Signer natif. La cryptographie et le statut ne sont pas rapportés séparément.",
    "nativeVerificationFailure": "Le service natif n’a pas pu terminer la vérification. Ce résultat ne détermine pas la validité.",
    "statusHelp": "Statut non vérifié signifie que le service Status natif n’a pas confirmé l’état du cycle de vie. La raison apparaît à côté de chaque entrée.",
    "nativeRevokeConfirmed": "Révocation confirmée par le service Status natif. La copie locale est conservée.",
    "requestedBy": "Demandé par",
    "JSON_CONTENT_TYPE_REQUIRED": "Utilisez application/json pour cette requête.",
    "REQUEST_BODY_UNAVAILABLE": "Le contenu de la requête est indisponible.",
    "REQUEST_TOO_LARGE": "La requête est trop volumineuse.",
    "password": "Mot de passe",
    "changePassword": "Modifier le mot de passe",
    "currentPassword": "Mot de passe actuel",
    "newPassword": "Nouveau mot de passe",
    "resetPassword": "Nouveau mot de passe temporaire (facultatif)",
    "PASSWORD_POLICY": "Utilisez au moins 12 caractères et au plus 72 octets UTF-8, sans caractères de contrôle.",
    "PASSWORD_CHANGE_REQUIRED": "Modifiez votre mot de passe temporaire pour continuer.",
    "PASSWORD_INCORRECT": "Le mot de passe actuel est incorrect.",
    "CSRF_INVALID": "Rechargez la page et réessayez.",
    "LOGIN_RATE_LIMITED": "Trop de tentatives de connexion. Réessayez plus tard.",
    "NATIVE_REFRESH_CONTRACT_UNVERIFIED": "L’interface native de renouvellement reste à vérifier.",
    "INVALID_VALIDITY_PERIOD": "Période de validité incorrecte",
    "not_yet_valid": "Pas encore valide",
    "suspended": "Suspendu",
    "credential": "Justificatif",
    "nativeChainComposition": "Composition native de la chaîne (déclarations)",
    "graphCycles": "Cycles de références",
    "graphTruncated": "Le graphe a atteint sa limite documentée de taille ou de profondeur.",
    "unresolvedReferences": "Références non résolues",
    "permission_clearing.request": "Demander des justificatifs au Clearing Center",
    "clearingMissing": "Importez les justificatifs JWT VC 2.0 requis avant de demander la conformité.",
    "clearingConfirm": "Envoyer les justificatifs sélectionnés à",
    "selectCredential": "Sélectionner un justificatif",
    "gaiax-legal-person": "Personne morale (gx:LegalPerson)",
    "gaiax-vat-id": "Numéro de TVA (gx:VatID)",
    "gaiax-terms-and-conditions": "Acceptation des conditions (gx:Issuer)",
    "clearingPhase_authorizing": "Vérification de la demande d’autorisation",
    "clearingPhase_presenting": "Envoi des justificatifs pour la conformité",
    "clearingPhase_receiving": "Réception du justificatif de conformité",
    "clearingPhase_verifying": "Vérification de la signature de l’émetteur",
    "clearingPhase_storing": "Enregistrement du justificatif dans OCM",
    "clearingPhase_complete": "Justificatif de conformité enregistré",
    "clearingUnknown": "L’échange a été interrompu. Vérifiez le résultat auprès du fournisseur avant une nouvelle demande.",
    "clearingStored": "Justificatif enregistré",
    "clearingStore": "Réessayer l’enregistrement",
    "CLEARING_HTTP_REJECTED": "Le fournisseur a refusé la demande.",
    "CLEARING_CONNECTION_FAILED": "Le fournisseur est inaccessible.",
    "CLEARING_TIMEOUT": "Le fournisseur n’a pas répondu dans le délai prévu.",
    "requestCredential": "Demander un justificatif"
  }
};

const auth = (() => {
  let csrf;
  const base = '/orce/ui-api/v1/auth';

  async function request(path, body) {
    const response = await fetch(base + path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...headers()
      },
      body: JSON.stringify(body || {})
    });
    const result = await response.json();
    if (!response.ok) {
      const error = Error(result.error?.code || 'AUTHENTICATION_REQUIRED');
      error.status = response.status;
      throw error;
    }
    return result.data;
  }

  async function setup() {
    try {
      csrf = (await request('/csrf')).csrfToken;
      return true;
    } catch (error) {
      if (error.status === 401) return false;
      throw error;
    }
  }
  async function login(username, password) {
    csrf = (await request('/login', {
      username,
      password
    })).csrfToken;
    location.assign('/orce/');
  }

  function csrfToken() {
    return csrf;
  }

  function headers() {
    return csrf ? {
      'X-CSRF-Token': csrf
    } : {};
  }
  async function logout() {
    await request('/logout');
    csrf = undefined;
    location.assign('/orce/');
  }
  async function changePassword(currentPassword, newPassword) {
    await request('/password', {
      currentPassword,
      newPassword
    });
    csrf = undefined;
    location.assign('/orce/');
  }

  return {
    setup,
    login,
    csrfToken,
    headers,
    logout,
    changePassword
  };
})();

// ProvenanceGraph

const ProvenanceGraph = {
  props: {
    controller: {
      type: Object,
      required: true
    },
    graph: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      date,
      pre
    } = props.controller;
    return () => {
      const g = props.graph;
      const entities = g.nodes.filter(n => n.kind === 'identity'),
        creds = g.nodes.filter(n => n.kind === 'credential'),
        positions = new Map();
      entities.forEach((n, i) => positions.set(n.id, {
        x: 20,
        y: 24 + i * 100
      }));
      creds.forEach((n, i) => positions.set(n.id, {
        x: 420,
        y: 24 + i * 100
      }));
      const height = Math.max(entities.length, creds.length, 1) * 100 + 25;
      return h('div', {
        class: 'provenance'
      }, [h('div', {
        class: 'graph-scroll'
      }, [h('svg', {
        viewBox: '0 0 800 ' + height,
        role: 'img',
        'aria-label': t('provenance')
      }, [
        h('defs', h('marker', {
          id: 'arrow',
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto-start-reverse'
        }, h('path', {
          d: 'M 0 0 L 10 5 L 0 10 z',
          fill: '#64748b'
        }))),
        ...g.edges.map(e => {
          const a = positions.get(e.from),
            b = positions.get(e.to),
            left = a.x < b.x;
          return h('path', {
            d: `M ${a.x+(left?350:0)} ${a.y+32} C 395 ${a.y+32}, 395 ${b.y+32}, ${b.x+(left?0:350)} ${b.y+32}`,
            fill: 'none',
            stroke: '#94a3b8',
            'stroke-width': 2,
            'marker-end': 'url(#arrow)'
          }, [h('title', t(e.role))]);
        }),
        ...g.nodes.map(n => {
          const p = positions.get(n.id);
          return h('g', {
            transform: `translate(${p.x} ${p.y})`
          }, [h('rect', {
            width: 350,
            height: 65,
            rx: 10,
            fill: n.kind === 'credential' ? '#eff6ff' : '#f8fafc',
            stroke: n.id === g.root ? '#2563eb' : '#cbd5e1'
          }), h('text', {
            x: 12,
            y: 25,
            fill: '#111827',
            'font-size': 12
          }, n.label.length > 44 ? n.label.slice(0, 41) + '…' : n.label), h('text', {
            x: 12,
            y: 47,
            fill: '#64748b',
            'font-size': 11
          }, n.kind === 'credential' ? date(n.issuedAt) : t('identity')), h('title', n
            .label)]);
        })
      ])]), h('ul', {
        class: 'identity-links'
      }, entities.filter(n => n.url).map(n => h('li', h('a', {
        href: n.url,
        target: '_blank',
        rel: 'noopener noreferrer'
      }, n.label)))), h('p', {
        class: 'muted'
      }, t('graphUnverified')), g.native?.result ? h('details', [h('summary', t(
        'nativeChainComposition')), pre(g.native.result)]) : null, g.cycles?.length ? h('p', t(
        'graphCycles') + ': ' + g.cycles.length) : null, g.truncated ? h('p', {
        role: 'status'
      }, t('graphTruncated')) : null, g.unresolvedReferences?.length ? h('details', [h('summary', t(
        'unresolvedReferences')), pre(g.unresolvedReferences)]) : null, g.native ? h('p', {
        class: 'muted'
      }, t('nativeChain') + ': ' + t(g.native.state) + (g.native.reason ? ' · ' + g.native
        .reason : '')) : null]);

    };
  }
};

// RelationshipsView

const RelationshipsView = {
  props: {
    controller: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      can,
      table,
      button,
      mutate,
      area,
      input,
      act,
      api,
      pre
    } = props.controller;
    return () => {
      return [can('relationships.write') ? h('div', {
          class: 'card'
        }, [h('h3', t('relationships')), h('div', {
            class: 'actions'
          }, [button('createInvitation', () => mutate('/relationships/invitations'), 'primary')]),
          area('invitation', s.invitation, v => s.invitation = v), button('acceptInvitation', () =>
            mutate('/relationships/accept', 'POST', {
              invitation: s.invitation
            })), input('label', s.label, v => s.label = v)
        ]) : null,
        table(['did', 'label', 'issuer', 'holder', 'credential', 'direction', 'status', 'action'], s
          .items.map(x => h('tr', {
            key: x.did
          }, [h('td', x.did), h('td', x.label), ...['issuer', 'holder', 'credential', 'direction',
            'status'
          ].map(k => h('td', x[k] || t('unknown'))), h('td', {
            class: 'actions'
          }, [button('view', () => act(async () => s.result = await api('/relationships/' +
            encodeURIComponent(x.did)))), ...(can('relationships.write') ? [button('save',
          () => mutate('/relationships/' + encodeURIComponent(x.did), 'PATCH', {
              label: s.label
            })), ...['block', 'unblock'].map(a => button(a, () => mutate(
            '/relationships/' + encodeURIComponent(x.did) + '/' + a))), button('remove',
            () => mutate('/relationships/' + encodeURIComponent(x.did), 'DELETE'),
            'danger')] : [])])]))), s.result?.invitation ? h('div', {
          class: 'card'
        }, [h('pre', s.result.invitation), button('copyInvitation', () => act(() => navigator
          .clipboard.writeText(s.result.invitation)))]) : s.result ? pre(s.result) : null
      ];
    };
  }
};

// ClearingCenterView

const ClearingCenterView = {
  props: {
    controller: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      button,
      select,
      act,
      api,
      load
    } = props.controller;
    return () => {
      return s.providers.map(p => h('article', {
        class: 'card',
        key: p.id
      }, [
        h('h3', p.name), h('p', [h('a', {
          href: p.url,
          target: '_blank',
          rel: 'noopener noreferrer'
        }, p.url)]), h('p', p.protocol + ' · ' + p.trustScope),
        h('p', t('clearingHelp')), p.code ? h('p', {
          role: 'status'
        }, t(p.code)) : null,
        ...s.clearingInputs.map(item => select(item.id, s.clearingSelection[item.id] || '', [
          ['', 'selectCredential'], ...item.credentials.map(c => [c.id, c.credentialId || c.id])
        ], value => s.clearingSelection[item.id] = value)),
        s.clearingInputs.some(item => !item.credentials.length) ? h('p', {
          role: 'status'
        }, t('clearingMissing')) : null,
        button('requestCredential', () => act(async () => {
            if (!confirm(t('clearingConfirm') + ' ' + p.url)) return;
            const result = await api('/clearing/requests', 'POST', {
              provider: p.id,
              credentials: {
                ...s.clearingSelection
              }
            });
            s.result = result;
            await load();
          }), 'primary', s.busy || !p.requestSupported || s.clearingInputs.length !== 3 || s
          .clearingInputs.some(item => !item.credentials.some(c => c.id === s.clearingSelection[item
            .id])) || s.clearingJobs.some(j => !['succeeded', 'failed', 'unknown', 'received']
            .includes(j.state))),
        ...s.clearingJobs.map(job => h('section', {
          class: 'card',
          key: job.id,
          'aria-live': 'polite'
        }, [
          h('strong', t('clearingPhase_' + job.phase)), h('p', t(job.state)), h('small', job
          .id),
          job.code ? h('p', {
            role: 'status'
          }, t(job.code) + (job.httpStatus ? ' (HTTP ' + job.httpStatus + ')' : '')) : null,
          job.state === 'unknown' ? h('p', t('clearingUnknown')) : null,
          job.credentialId ? h('p', t('clearingStored') + ': ' + job.credentialId) : null,
          job.state === 'received' ? button('clearingStore', () => act(async () => {
            await api('/clearing/requests/' + encodeURIComponent(job.id) + '/store',
              'POST');
            await load();
          })) : null
        ]))
      ]));
    };
  }
};

// IssueCredentialView

const IssueCredentialView = {
  props: {
    controller: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      select,
      input,
      area,
      button,
      act,
      mutate,
      ocmPath,
      lifecycleResults,
      api,
      pre,
      download
    } = props.controller;
    return () => {
      const type = s.types.find(x => x.id === s.type);
      return [type?.demo ? h('div', {
          class: 'banner'
        }, [h('strong', t('demo')), h('p', t('demoHelp'))]) : null,
        h('div', {
          class: 'card'
        }, [select('type', s.type, s.types.map(x => [x.id, x.name || x.id]), v => {
            s.type = v;
            s.claims = {};
            s.advancedClaims = '{}';
          }), ...Object.entries(type?.fields || {}).map(([k]) => input(k, s.claims[k] || '', v => s
            .claims[k] = v)), !Object.keys(type?.fields || {}).length ? area('claims', s
            .advancedClaims, v => s.advancedClaims = v) : null, type?.schema ? h('details', [h(
            'summary', t('schema')), pre(type.schema)]) : null,
          button('review', () => act(async () => {
            const claims = Object.keys(type?.fields || {}).length ? s.claims : JSON.parse(s
              .advancedClaims);
            await mutate(ocmPath('/issuance'), 'POST', {
              credentialConfigurationId: s.type,
              claims
            });
          }), 'primary', s.busy || !type || type.available === false)
        ]),
        lifecycleResults(), s.result ? h('div', {
          class: 'card'
        }, [h('h3', t('result')), s.result.requestId ? button('inspectOperation', () => act(
      async () => {
            s.result = await api(ocmPath('/issuance/' + encodeURIComponent(s.result
            .requestId)));
          })) : null, s.result.offerQr ? h('img', {
          src: s.result.offerQr,
          alt: t('offerQr'),
          width: 280,
          height: 280
        }) : null, s.result.offerUrl ? h('div', [h('p', t('shareOfferHelp')), h('pre', s.result
          .offerUrl), h('div', {
          class: 'actions'
        }, [button('copyOffer', () => act(() => navigator.clipboard.writeText(s.result
          .offerUrl))), button('download', () => download(s.result.offer,
          'credential-offer.json'))])]) : pre(s.result)]) : null
      ];
    };
  }
};

// ReceiveCredentialsView

const ReceiveCredentialsView = {
  props: {
    controller: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      area,
      button,
      mutate,
      ocmPath,
      input,
      select,
      lifecycleResults,
      table,
      pill,
      pre
    } = props.controller;
    return () => {
      return [
        h('div', {
          class: 'card'
        }, [h('h3', t('receive')), h('p', t('offerHelp')), area('offer', s.offer, v => s.offer = v),
          h('div', {
            class: 'actions'
          }, [button('import', () => mutate(ocmPath('/offers/import'), 'POST', {
            offer: s.offer,
            source: 'paste'
          }), 'primary'), button('clearing', () => change('clearing'))]), input('txCode', s.txCode,
            v => s.txCode = v, 'password'), null
        ]),
        h('details', {
          class: 'card'
        }, [h('summary', t('importCredential')), h('p', t('importCredentialHelp')), area(
          'credentialJson', s.rawCredential, v => s.rawCredential = v), button('importCredential',
        () => {
          let credential = s.rawCredential;
          try {
            credential = JSON.parse(credential);
          } catch {}
          return mutate(ocmPath('/credentials/import'), 'POST', {
            credential
          });
        })]),
        lifecycleResults(), s.result?.upstreamRequestId ? h('div', {
          class: 'banner'
        }, [h('strong', t('requestId') + ': ' + s.result.upstreamRequestId), s.result.accepted ===
          true ? h('p', t(s.result.storageConfirmation === 'confirmed' ? 'acceptedStored' :
            'acceptedAwaitingStorage')) : null, s.result.code ? h('p', t(s.result.code)) : null, s
          .result.storageError ? h('p', s.result.storageError) : null
        ]) : null,
        h('h3', t('pendingOffers')), table(['issuer', 'type', 'status', 'action'], s.items.map(o => h(
          'tr', {
            key: o.requestId
          }, [h('td', o.issuer || t('unknown')), h('td', o.credentialConfigurationIds?.join(', ')),
            h('td', pill(o.state)), h('td', {
              class: 'actions'
            }, [button('accept', () => mutate(ocmPath('/offers/' + encodeURIComponent(o
              .requestId) + '/accept'), 'POST', {
              ...(s.txCode ? {
                txCode: s.txCode
              } : {}),
            }), 'primary'), button('reject', () => mutate(ocmPath('/offers/' +
              encodeURIComponent(o.requestId) + '/reject')))])
          ])))
      ];
    };
  }
};

// CredentialsView

const CredentialsView = {
  props: {
    controller: {
      type: Object,
      required: true
    }
  },
  setup(props) {
    const {
      s,
      t,
      input,
      select,
      act,
      load,
      table,
      pill,
      detail,
      button
    } = props.controller;
    return () => {
      return [
        s.counts && s.loaded ? h('div', {
          class: 'stats'
        }, [
          ['total', s.counts.total],
          ['active', s.counts.active],
          ['expired', s.counts.expired],
          ['revoked', s.counts.revoked],
          ['not_checked', s.counts.notChecked]
        ].map(([k, n]) => h('div', {
          class: 'stat-card'
        }, [h('span', t(k)), h('strong', String(n))]))) : null,
        h('form', {
          class: 'filter-bar',
          onSubmit: e => {
            e.preventDefault();
            s.cursor = null;
            act(() => load());
          }
        }, [
          input('search', s.query, v => s.query = v), select('sort', s.sort, [
            ['issuedAt', 'issued'],
            ['expiresAt', 'expires'],
            ['id', 'credentialId']
          ], v => s.sort = v),
          select('direction', s.direction, [
            ['desc', 'newest'],
            ['asc', 'oldest']
          ], v => s.direction = v), select('status', s.status, [
            ['', 'all'],
            ['active', 'active'],
            ['expired', 'expired'],
            ['revoked', 'revoked'],
            ['suspended', 'suspended'],
            ['not_yet_valid', 'not_yet_valid'],
            ['not_checked', 'not_checked']
          ], v => s.status = v),
          h('button', {
            type: 'submit',
            class: 'primary',
            disabled: s.busy
          }, t('search'))
        ]),
        h('p', {
          class: 'muted'
        }, t('statusHelp')),
        table(['type', 'issuer', 'status', 'expires', 'action'], s.items.map(d => h('tr', {
          key: d.id
        }, [h('td', [h('strong', d.types?.join(', ') || t('unknown')), h('small', {
          class: 'row-id'
        }, d.id)]), h('td', {
          class: 'identity-cell'
        }, d.issuer?.id || t('unknown')), h('td', [pill(d.status?.state), d.status?.reason ? h(
          'small', {
            class: 'row-id'
          }, d.status.reason) : null]), h('td', d.expiresAt ? new Date(d.expiresAt)
          .toLocaleDateString(s.locale) : '—'), h('td', button('view', () => detail(d.id)))]))),
        h('div', {
          class: 'pagination'
        }, [h('span', s.loaded ? t('total') + ': ' + s.total : ''), select('pageSize', String(s
          .pageSize), [
          ['10', '10'],
          ['25', '25'],
          ['50', '50'],
          ['100', '100']
        ], v => {
          s.pageSize = Number(v);
          s.cursor = null;
          act(() => load());
        }), button('back', () => {
          s.cursor = null;
          act(() => load());
        }), button('next', () => {
          s.cursor = s.next;
          act(() => load());
        }, '', s.busy || !s.next)])
      ];
    };
  }
};

// App

const apiBase = '/orce/ui-api/v1';
const App = {
  setup() {
    const s = reactive({
      locale: 'en',
      me: null,
      view: 'credentials',
      busy: false,
      error: null,
      notice: '',
      items: [],
      total: 0,
      cursor: null,
      next: null,
      query: '',
      detail: null,
      verification: null,
      raw: false,
      result: null,
      offer: '',
      txCode: '',
      types: [],
      type: '',
      claims: {},
      role: null,
      roleList: [],
      roleName: '',
      roleDescription: '',
      permissions: [],
      userSearch: '',
      assignment: {},
      invitation: '',
      label: '',
      chain: '',
      connected: false,
      updated: null,
      loaded: false,
      context: 'ocm',
      loginUsername: '',
      loginPassword: '',
      currentPassword: '',
      newPassword: '',
      sort: 'issuedAt',
      direction: 'desc',
      status: '',
      pageSize: 25,
      counts: null,
      graph: null,
      graphError: null,
      registry: [],
      providers: [],
      clearingInputs: [],
      clearingSelection: {},
      clearingJobs: [],
      vp: '',
      rawCredential: '',
      advancedClaims: '{}',
      navOpen: false,
      provider: "",
      connections: null,
      connectionDraft: null,
      connectionEditing: false,
      trustedHostsText: "",
      nativeTypes: [],
      registryDraft: null,
      registryEditing: false,
      roleEditing: false,
      selectedUser: null,
      userDraft: null,
      effective: [],
      connectionTest: null,
      passwordEditing: false
    });
    let socket, timer, refreshTimer, generation = 0,
      lastFocus, abort = new AbortController();
    const keys = new Map();
    const t = k => locales[s.locale][k] || k,
      can = p => s.me?.permissions.includes(p);
    const tabs = [
      ['credentials', 'credentials.read'],
      ['registry', 'credentials.issue'],
      ['clearing', 'clearing.request'],
      ['receive', 'credentials.receive'],
      ['issue', 'credentials.issue'],
      ['relationships', 'relationships.read'],
      ['roles', 'roles.read'],
      ['assignments', 'roles.read'],
      ['permissions', 'roles.read'],
      ['audit', 'audit.read'],
      ['health', 'system.health.read'],
    ];
    async function api(path, method = 'GET', body) {
      const mutation = !['GET'].includes(method) && !path.endsWith('/verify') && path !=
        '/credential-chains/resolve';
      const fingerprint = method + path + JSON.stringify(body || {});
      if (mutation && !keys.has(fingerprint)) keys.set(fingerprint, crypto.randomUUID());
      const r = await fetch(apiBase + path, {
        method,
        headers: {
          ...auth.headers(),
          'content-type': 'application/json',
          ...(mutation ? {
            'X-Idempotency-Key': keys.get(fingerprint)
          } : {})
        },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: abort.signal
      });
      let out;
      try {
        out = await r.json();
      } catch {
        if (mutation && path.endsWith('/issuance')) s.notice = t('outcomeUnknown');
        const e = Error(r.ok ? 'API_INVALID_RESPONSE' : 'API_HTTP_ERROR');
        e.httpStatus = r.status;
        e.requestId = r.headers?.get('x-request-id') || undefined;
        throw e;
      }
      if (!out || typeof out !== 'object') {
        const e = Error('API_INVALID_RESPONSE');
        e.httpStatus = r.status;
        throw e;
      }
      if (!r.ok) {
        if (r.status === 401) {
          s.me = null;
          socket?.disconnect();
          location.assign('/orce/');
        }
        if (path.endsWith('/issuance') && out.error?.operationId) {
          s.result = {
            requestId: out.error.operationId,
            state: out.error.operationState
          };
          if (out.error.operationState === 'unknown') s.notice = t('outcomeUnknown');
        }
        if (mutation && path === '/clearing/requests' && out.error?.operationState === 'failed') keys
          .delete(fingerprint);
        if (mutation && ['NATS_REQUIRED_FOR_ISSUANCE', 'VALIDATION_ERROR', 'UNKNOWN_CREDENTIAL_TYPE',
            'ISSUER_INITIALIZING', 'ISSUANCE_NO_RESPONDERS'
          ].includes(out.error?.code)) keys.delete(fingerprint);
        const e = Error(out.error?.code || 'ERROR');
        e.requestId = out.requestId;
        Object.assign(e, {
          upstream: out.error?.upstream,
          upstreamStatus: out.error?.upstreamStatus,
          reason: out.error?.reason
        });
        throw e;
      }
      if (mutation && r.status !== 202) keys.delete(fingerprint);
      return out.data;
    }
    async function act(fn) {
      s.busy = true;
      s.error = null;
      s.notice = '';
      try {
        await fn();
      } catch (e) {
        if (e.name !== 'AbortError') s.error = {
          code: e.message,
          requestId: e.requestId,
          upstream: e.upstream,
          upstreamStatus: e.upstreamStatus,
          reason: e.reason,
          httpStatus: e.httpStatus
        };
      } finally {
        s.busy = false;
      }
    }
    async function load(silent = false) {
      const gen = ++generation;
      const view = s.view;
      try {
        let d;
        if (view === 'credentials') d = await api(ocmPath('/credentials?') + new URLSearchParams({
          q: s.query,
          pageSize: String(s.pageSize),
          sort: s.sort,
          direction: s.direction,
          status: s.status,
          ...(s.cursor ? {
            cursor: s.cursor
          } : {})
        }));
        else if (view === 'receive') d = await api('/offers');
        else if (view === 'issue' || view === 'registry') {
          d = await api(ocmPath('/credential-types'));
          s.registry = d.items;
          s.nativeTypes = d.nativeTypes || [];
          if (gen !== generation) return;
          s.loaded = true;
          s.types = d.items;
          if (!s.type && d.items.length) s.type = d.items[0].id;
          return;
        } else if (view === 'clearing') {
          const [catalog, inputs, jobs] = await Promise.all([api('/clearing/providers'), api(
            '/clearing/inputs'), api('/clearing/requests')]);
          if (gen !== generation) return;
          d = catalog;
          s.providers = catalog.items;
          s.clearingInputs = inputs.items;
          s.clearingJobs = jobs.items;
        } else if (view === 'relationships') d = await api('/relationships');
        else if (view === 'roles' || view === 'permissions') d = await api('/roles');
        else if (view === 'assignments') {
          const r = await api('/roles');
          s.roleList = r.items;
          d = await api('/role-assignments?search=' + encodeURIComponent(s.userSearch));
        } else if (view === 'audit') d = await api('/audit');
        else d = await api('/health/dependencies');
        if (gen !== generation) return;
        s.loaded = true;
        s.error = null;
        s.items = d.items || [];
        if (view === 'health') s.result = d;
        s.total = d.total || 0;
        s.counts = d.counts || null;
        s.next = d.nextCursor;
        s.updated = new Date();
      } catch (e) {
        if (gen !== generation || e.name === 'AbortError') return;
        s.loaded = false;
        if (!silent) throw e;
        s.error = {
          code: e.message,
          requestId: e.requestId,
          upstream: e.upstream,
          upstreamStatus: e.upstreamStatus,
          reason: e.reason,
          httpStatus: e.httpStatus
        };
      }
    }
    const ocmPath = path => path;
    async function change(view) {
      s.view = view;
      s.loaded = false;
      s.updated = null;
      s.items = [];
      s.result = null;
      s.detail = null;
      s.registryDraft = null;
      s.roleEditing = false;
      s.selectedUser = null;
      s.userDraft = null;
      s.connectionTest = null;
      s.cursor = null;
      s.notice = '';
      await act(() => load());
    }
    async function mutate(path, method = 'POST', body = {}, confirmKey = 'confirm') {
      if (!confirm(t(confirmKey))) return;
      await act(async () => {
        s.result = await api(path, method, body);
        if (method === 'DELETE' && s.detail) close();
        s.notice = ['unknown', 'dispatching'].includes(s.result?.state) ? t('outcomeUnknown') : path
          .includes('/offers/') && path.endsWith('/accept') ? t(s.result?.storageConfirmation ===
            'confirmed' ? 'acceptedStored' : 'acceptedAwaitingStorage') : path.endsWith(
          '/revoke') && s.result?.state === 'succeeded' ? t('nativeRevokeConfirmed') : t(
            'succeeded');
        if (path.endsWith('/revoke') && s.detail && s.result?.state === 'succeeded') {
          s.detail.status = {
            state: 'revoked',
            source: 'XFSC Status'
          };
          s.detail.revocationConfirmed = true;
        }
        await load(true);
      });
    }

    function button(label, fn, cls = '', disabled = s.busy) {
      return h('button', {
        type: 'button',
        class: cls,
        disabled,
        onClick: fn
      }, t(label));
    }

    function input(label, value, update, type = 'text') {
      const ident = 'f-' + label;
      return h('div', [h('label', {
        for: ident
      }, t(label.replace(/\d+$/, ''))), h('input', {
        id: ident,
        type,
        value,
        onInput: e => update(e.target.value)
      })]);
    }

    function area(label, value, update) {
      return h('div', [h('label', {
        for: 'a-' + label
      }, t(label)), h('textarea', {
        id: 'a-' + label,
        value,
        onInput: e => update(e.target.value)
      })]);
    }
    const pre = x => h('pre', JSON.stringify(x, null, 2));
    const pill = x => h('span', {
      class: 'pill'
    }, t(x || 'unknown'));

    function table(head, rows) {
      return h('div', {
        class: 'table-wrap'
      }, [h('table', [h('thead', h('tr', head.map(x => h('th', {
        scope: 'col'
      }, t(x))))), h('tbody', rows)]), s.loaded && !rows.length ? h('p', {
        class: 'muted'
      }, t('empty')) : null]);
    }
    async function detail(key) {
      lastFocus = document.activeElement;
      await act(async () => {
        s.detail = await api(ocmPath('/credentials/' + encodeURIComponent(key)));
        s.verification = null;
        s.raw = false;
        s.graph = null;
        s.graphError = null;
        try {
          s.graph = await api(ocmPath('/credentials/' + encodeURIComponent(key) + '/provenance'));
        } catch (e) {
          s.graphError = e.message;
        }
      });
      queueMicrotask(() => document.querySelector('.dialog button')?.focus());
    }

    function close() {
      s.detail = null;
      s.verification = null;
      s.raw = false;
      lastFocus?.focus();
    }

    function dialog() {
      const d = s.detail;
      if (!d) return null;
      return h('div', {
        class: 'overlay',
        onKeydown: e => {
          if (e.key === 'Escape') close();
          if (e.key === 'Tab') {
            const els = [...e.currentTarget.querySelectorAll('button,input,textarea,select,a[href]')]
              .filter(x => !x.disabled);
            if (!els.length) return;
            if (e.shiftKey && document.activeElement === els[0]) {
              e.preventDefault();
              els.at(-1).focus();
            } else if (!e.shiftKey && document.activeElement === els.at(-1)) {
              e.preventDefault();
              els[0].focus();
            }
          }
        }
      }, h('section', {
        class: 'dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'detail-title'
      }, [
        h('div', {
          class: 'dialog-head'
        }, [h('h2', {
          id: 'detail-title'
        }, d.types.join(', ') || d.id), button('close', close)]),
        h('div', {
          class: 'grid'
        }, ['issuer', 'holder', 'verifier'].map((k, i) => h('div', {
          class: 'card'
        }, [h('h3', t(k)), h('p', i === 0 ? d.issuer.id : i === 1 ? (d.holder?.label || d
          .subject.id || t('notDeclared')) : (s.verification?.service || s.graph
          ?.verifications?.[0]?.service || t('noVerification')))]))), h('p', {
          class: 'muted'
        }, t('declarations')), !s.verification ? h('p', t('noVerification')) : null,
        h('div', {
          class: 'actions'
        }, [can('credentials.verify') && d.capabilities?.verify !== false ? button('verify', () =>
            act(async () => {
              s.verification = await api(ocmPath('/credentials/' + encodeURIComponent(d.id) +
                '/verify'), 'POST');
              try {
                s.graph = await api(ocmPath('/credentials/' + encodeURIComponent(d.id) +
                  '/provenance'));
              } catch (e) {
                s.graphError = e.message;
              }
            }), 'primary') : null, can('credentials.revoke') && d.capabilities?.revoke && !d
          .revocationConfirmed ? button('revoke', () => mutate(ocmPath('/credentials/' +
            encodeURIComponent(d.id) + '/revoke'), 'POST', {}, 'confirmRevoke'), 'danger') : null,
          can('credentials.delete') && d.capabilities?.delete !== false ? button('delete', () =>
            mutate(ocmPath('/credentials/' + encodeURIComponent(d.id)), 'DELETE', {},
              'confirmDelete'), 'danger') : null
        ]),
        d.revocationConfirmed ? h('p', {
          class: 'banner',
          role: 'status'
        }, t('nativeRevokeConfirmed')) : null,
        s.verification ? h('div', {
          class: ['card', 'verification-' + s.verification.overall],
          role: 'status'
        }, [h('h3', s.verification.overall === 'valid' ? t('verifiedSuccessfully') : t('overall') +
          ': ' + t(s.verification.overall)), h('p', t('cryptographic') + ': ' + t(s.verification
          .cryptographic.state)), h('p', t('status') + ': ' + t(s.verification.status.state)), h(
          'p', {
            class: 'muted'
          }, t('nativeVerdict')), s.verification.code ? h('p', {
          role: 'alert'
        }, t('nativeVerificationFailure') + ' (' + s.verification.code + (s.verification
          .upstreamStatus ? ' / HTTP ' + s.verification.upstreamStatus : '') + ')' + (s
          .verification.requestId ? ' / ' + t('requestId') + ': ' + s.verification.requestId :
          '')) : null]) : null,
        h('h3', t('claims')), pre(s.verification?.disclosedClaims || d.claims), button('raw', () => s
          .raw = !s.raw), s.raw ? pre(d.raw) : null,
        h('div', {
          class: 'detail-meta'
        }, [h('span', t('issued') + ': ' + date(d.issuedAt)), h('span', t('expires') + ': ' + date(d
          .expiresAt)), h('span', t('format') + ': ' + d.format)]),
        !d.capabilities?.revoke ? h('p', {
          class: 'muted'
        }, t('revocationLimit') + ' (' + (d.capabilities?.revocationReason ||
          'STATUS_NOT_MANAGED_HERE') + ')') : null,
        h('div', {
          class: 'actions'
        }, [button('download', () => download(d.raw, d.id + '.json')), can('credentials.receive') ?
          button('replacement', () => {
            close();
            change('receive');
          }) : null
        ]),
        h('h3', t('provenance')), h('p', {
          class: 'muted'
        }, t('graphHelp')), s.graph ? provenanceGraph(s.graph) : s.graphError ? h('p', {
          role: 'status'
        }, s.graphError) : null,
        s.graph?.verifications?.length ? h('div', {
          class: 'card'
        }, [h('h3', t('verificationHistory')), table(['time', 'verifier', 'overall'], s.graph
          .verifications.map(v => h('tr', [h('td', date(v.timestamp)), h('td', (v.verifierName ||
            v.verifier) + ' / ' + (v.service || 'XFSC Signer')), h('td', t(v.overall))])))]) : null,
        s.verification ? h('div', {
          class: 'verification-evidence'
        }, [h('strong', t('requestedBy')), h('p', s.verification.requestedBy?.username || s.me
          .username || s.me.subject), h('span', t('verificationSession'))]) : null

      ]));
    }
    const date = value => value ? new Date(value).toLocaleString(s.locale) : '—';

    function download(value, name) {
      const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = name.replace(/[^A-Za-z0-9_.-]/g, '_');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function select(label, value, options, update) {
      const ident = 's-' + label;
      return h('div', {
        class: 'field'
      }, [h('label', {
        for: ident
      }, t(label)), h('select', {
        id: ident,
        value,
        onChange: e => update(e.target.value)
      }, options.map(([v, l]) => h('option', {
        value: v
      }, t(l))))]);
    }

    function credentials() {
      return [h(CredentialsView, {
        controller
      })];
    }

    function receive() {
      return [h(ReceiveCredentialsView, {
        controller
      })];
    }

    function registry() {
      const d = s.registryDraft;
      return [h('p', {
          class: 'muted'
        }, t('registryHelp')),
        true ? h('div', {
          class: 'actions'
        }, [button('createType', () => {
          s.registryEditing = false;
          s.registryDraft = {
            id: '',
            name: '',
            description: '',
            format: '',
            issuerConfigurationId: '',
            fields: {},
            revision: 0,
            fieldRows: []
          };
        }, 'primary')]) : null,
        d ? h('section', {
          class: 'card editor-card',
          'aria-label': t('typeEditor')
        }, [h('h3', t(s.registryEditing ? 'editType' : 'createType')),
          s.registryEditing ? h('p', [t('identifier') + ': ', h('code', d.id)]) : input('identifier', d
            .id, v => d.id = v), input('name', d.name, v => d.name = v), area('description', d
            .description, v => d.description = v), d.issuerConfigurationId ? h('p', [t('format') + ': ',
            h('code', s.nativeTypes.find(x => x.id === d.issuerConfigurationId)?.format || d.format ||
              '—')
          ]) : input('format', d.format, v => d.format = v),
          select('issuerConfiguration', d.issuerConfigurationId, [
            ['', 'noIssuer'], ...s.nativeTypes.map(x => [x.id, x.id])
          ], v => d.issuerConfigurationId = v), h('p', {
            class: 'muted'
          }, t('registryIssuerHelp')),
          h('h4', t('claimFields')), ...d.fieldRows.map((f, i) => h('div', {
            class: 'claim-field',
            key: i
          }, [input('fieldName' + i, f.name, v => f.name = v), h('label', [h('input', {
            type: 'checkbox',
            checked: f.required,
            onChange: e => f.required = e.target.checked
          }), t('required')]), input('maxLength' + i, f.maxLength, v => f.maxLength = Number(v),
            'number'), button('remove', () => d.fieldRows.splice(i, 1))])), button('addField', () => d
            .fieldRows.push({
              name: '',
              required: false,
              maxLength: 256
            })),
          h('div', {
            class: 'actions'
          }, [button('save', () => act(async () => {
            if (new Set(d.fieldRows.map(f => f.name)).size !== d.fieldRows.length)
            throw Error('DUPLICATE_FIELD');
            const {
              fieldRows,
              ...rest
            } = d;
            const body = {
              ...rest,
              fields: Object.fromEntries(fieldRows.map(({
                name,
                ...rule
              }) => [name, rule]))
            };
            await api(s.registryEditing ? '/credential-types/' + encodeURIComponent(d.id) :
              '/credential-types', s.registryEditing ? 'PATCH' : 'POST', body);
            s.registryDraft = null;
            s.registryFields = undefined;
            await load();
            s.notice = t('succeeded');
          }), 'primary'), button('cancel', () => {
            s.registryDraft = null;
            s.registryFields = undefined;
          })])
        ]) : null,
        input('search', s.query, v => s.query = v), table(['type', 'format', 'issuer', 'status',
          'action'], s.registry.filter(x => !s.query || [x.id, x.name, x.format, ...(x.types || [])].join(
            ' ').toLowerCase().includes(s.query.toLowerCase())).map(x => h('tr', {
            key: x.id
          }, [
            h('td', [h('strong', x.name || x.id), h('small', {
              class: 'row-id'
            }, x.id), h('p', x.description || '')]), h('td', x.format || '—'), h('td', x
              .issuerConfigurationId || x.identifier || t('noIssuer')), h('td', pill(x.available ===
              false ? 'unavailable' : x.demo ? 'demo' : 'available')),
            h('td', h('div', {
              class: 'actions'
            }, [button('issue', () => {
              s.type = x.id;
              change('issue');
            }, '', s.busy || x.available === false), s.context === 'ocm' ? button('edit',
          () => {
              s.registryEditing = true;
              s.registryFields = undefined;
              s.registryDraft = {
                id: x.id,
                name: x.name || x.id,
                description: x.description || '',
                format: x.format || '',
                issuerConfigurationId: x.issuerConfigurationId ?? x.id,
                fields: JSON.parse(JSON.stringify(x.fields || {})),
                revision: x.revision || 0,
                fieldRows: Object.entries(x.fields || {}).map(([name, rule]) => ({
                  name,
                  required: Boolean(rule.required),
                  maxLength: rule.maxLength || 256
                }))
              };
            }) : null, s.context === 'ocm' ? button('deleteType', () => mutate(
              '/credential-types/' + encodeURIComponent(x.id), 'DELETE', {
                revision: x.revision || 0
              }, 'confirmDeleteType'), 'danger') : null]))
          ])))
      ];
    }

    function issue() {
      return [h(IssueCredentialView, {
        controller
      })];
    }

    function clearing() {
      return [h(ClearingCenterView, {
        controller
      })];
    }

    function relationships() {
      return [h(RelationshipsView, {
        controller
      })];
    }

    function provenanceGraph(g) {
      return h(ProvenanceGraph, {
        controller,
        graph: g
      });
    }

    function health() {
      const d = s.result;
      if (!d) return [];
      return [h('div', {
        class: 'stats'
      }, [h('div', {
        class: 'stat-card'
      }, [h('span', t('version')), h('strong', d.version || '—')]), h('div', {
        class: 'stat-card'
      }, [h('span', 'NATS'), h('strong', t(d.nats?.connected ? 'connected' : 'disconnected'))]), h(
        'div', {
          class: 'stat-card'
        }, [h('span', t('eventMode')), h('strong', {
          class: 'small-value'
        }, d.nats?.mode || '—')])]), table(['service', 'status', 'lastSuccess', 'error'], (d
        .upstreams || []).map(x => h('tr', [h('td', x.name), h('td', pill(x.lastErrorCode ?
        'unavailable' : x.lastSuccessAt ? 'available' : 'unknown')), h('td', date(x
        .lastSuccessAt)), h('td', [x.lastErrorCode || '—', x.lastReason ? h('small', {
        class: 'row-id'
      }, x.lastReason) : null])]))), h('p', {
        class: 'muted'
      }, t('healthHelp')), button('downloadEvidence', () => download({
        checkedAt: new Date().toISOString(),
        ...d
      }, 'ocm-health-evidence.json'))];
    }

    function permissionGroups(selected, update) {
      const all = s.items.filter(r => r.kind === 'atomic');
      return h('div', {
        class: 'permission-grid'
      }, [...new Set(all.map(r => r.name.split('.')[0]))].map(group => h('fieldset', [h('legend', t(
        'permissionGroup_' + group)), ...all.filter(r => r.name.startsWith(group + '.')).map(r =>
        h('label', {
          class: 'permission-option'
        }, [update ? h('input', {
          type: 'checkbox',
          checked: selected.includes(r.name),
          onChange: e => update(e.target.checked ? [...selected, r.name] : selected.filter(
            x => x !== r.name))
        }) : null, h('span', [t('permission_' + r.name), h('small', {
          class: 'row-id'
        }, r.name)])]))])));
    }

    function permissionsPanel() {
      return [h('p', {
        class: 'muted'
      }, t('permissionsHelp')), permissionGroups([], null)];
    }

    function roles() {
      return [h('p', {
          class: 'muted'
        }, t('refreshRoles')), can('admin.users') ? button('createRole', () => {
          s.roleEditing = true;
          s.role = null;
          s.roleName = '';
          s.roleDescription = '';
          s.permissions = [];
        }, 'primary') : null,
        s.roleEditing ? h('section', {
          class: 'card editor-card'
        }, [h('h3', t(s.role ? 'editRole' : 'createRole')), s.role ? h('p', [t('name') + ': ', h('code',
          s.roleName)]) : input('name', s.roleName, v => s.roleName = v), input('description', s
          .roleDescription, v => s.roleDescription = v), permissionGroups(s.permissions, v => s
          .permissions = v), h('div', {
          class: 'actions'
        }, [button('save', () => act(async () => {
          await api(s.role ? '/roles/' + s.role : '/roles', s.role ? 'PATCH' : 'POST', {
            name: s.roleName,
            description: s.roleDescription,
            permissions: s.permissions
          });
          s.roleEditing = false;
          await load();
          s.notice = t('refreshRoles');
        }), 'primary'), button('cancel', () => s.roleEditing = false)])]) : null,
        table(['name', 'description', 'permissions', 'action'], s.items.filter(r => r.kind ===
          'composite').map(r => h('tr', {
          key: r.id
        }, [h('td', r.name), h('td', r.description || '—'), h('td', h('details', [h('summary',
          String(r.permissions.length) + ' ' + t('permissions')), h('ul', r.permissions.map(
          p => h('li', t('permission_' + p))))])), h('td', r.editable && can('admin.users') ? h(
          'div', {
            class: 'actions'
          }, [button('edit', () => {
            s.roleEditing = true;
            s.role = r.id;
            s.roleName = r.name;
            s.roleDescription = r.description || '';
            s.permissions = [...r.permissions];
          }), button('deleteRole', () => mutate('/roles/' + r.id, 'DELETE', {},
            'confirmDeleteRole'), 'danger')]) : t('system'))])))
      ];
    }

    function assignments() {
      const u = s.selectedUser,
        d = s.userDraft;
      return [h('p', {
          class: 'muted'
        }, t('refreshRoles')), h('div', {
          class: 'actions'
        }, [input('searchUsers', s.userSearch, v => s.userSearch = v), button('search', () => act(() =>
          load())), can('admin.users') ? button('createUser', () => {
          s.userDraft = {
            username: '',
            email: '',
            firstName: '',
            lastName: '',
            enabled: true,
            temporaryPassword: ''
          };
          s.selectedUser = null;
        }, 'primary') : null]),
        d ? h('section', {
          class: 'card editor-card'
        }, [h('h3', t(d.id ? 'editUser' : 'createUser')), d.id ? h('p', d.username) : input('username',
          d.username, v => d.username = v), ...['email', 'firstName', 'lastName'].map(key => input(
          key, d[key] || '', v => d[key] = v)), h('label', [h('input', {
          type: 'checkbox',
          checked: d.enabled,
          onChange: e => d.enabled = e.target.checked
        }), t('enabled')]), input(d.id ? 'resetPassword' : 'temporaryPassword', d.temporaryPassword ||
          '', v => d.temporaryPassword = v, 'password'), h('p', {
          class: 'muted'
        }, t('temporaryPasswordHelp')), h('div', {
          class: 'actions'
        }, [button('save', () => act(async () => {
          const {
            id,
            ...body
          } = d;
          if (!body.temporaryPassword) delete body.temporaryPassword;
          await api(id ? '/users/' + id : '/users', id ? 'PATCH' : 'POST', body);
          s.userDraft = null;
          await load();
          s.notice = t('succeeded');
        }), 'primary'), button('cancel', () => s.userDraft = null)])]) : null,
        table(['user', 'email', 'status', 'roles', 'action'], s.items.map(user => h('tr', {
          key: user.id
        }, [h('td', [h('strong', user.username), h('small', {
          class: 'row-id'
        }, user.id)]), h('td', user.email || '—'), h('td', pill(user.enabled ? 'enabled' :
          'disabled')), h('td', user.roles.map(r => r.name).join(', ') || '—'), h('td', h('div', {
          class: 'actions'
        }, [button('manageAccess', () => act(async () => {
          s.selectedUser = user;
          s.assignment[user.id] = user.roles.map(r => r.id);
          s.effective = (await api('/role-assignments/' + user.id + '/effective'))
            .permissions;
        })), can('admin.users') ? button('edit', () => {
          const {
            roles,
            ...value
          } = user;
          s.userDraft = {
            ...value
          };
          s.selectedUser = null;
        }) : null, can('admin.users') ? button('deleteUser', () => mutate('/users/' + user
          .id, 'DELETE', {}, 'confirmDeleteUser'), 'danger') : null]))]))),
        u ? h('section', {
          class: 'card editor-card'
        }, [h('h3', t('manageAccess') + ' · ' + u.username), h('fieldset', [h('legend', t('roles')), ...
          s.roleList.filter(r => r.kind === 'composite').map(r => h('label', {
            class: 'permission-option'
          }, [h('input', {
            type: 'checkbox',
            disabled: !can('admin.users'),
            checked: s.assignment[u.id].includes(r.id),
            onChange: e => {
              s.assignment[u.id] = e.target.checked ? [...s.assignment[u.id], r.id] : s
                .assignment[u.id].filter(x => x !== r.id);
            }
          }), r.name]))
        ]), h('h4', t('effectivePermissions')), h('ul', s.effective.map(p => h('li', t('permission_' +
          p)))), h('div', {
          class: 'actions'
        }, [can('admin.users') ? button('save', () => act(async () => {
          await api('/role-assignments/' + u.id, 'PUT', {
            roleIds: s.assignment[u.id]
          });
          s.effective = (await api('/role-assignments/' + u.id + '/effective')).permissions;
          await load();
          s.notice = t('refreshRoles');
        }), 'primary') : null, button('close', () => s.selectedUser = null)])]) : null
      ];
    }

    function connectionResults() {
      const r = s.connectionTest;
      if (!r) return null;
      return h('section', {
        class: 'card',
        role: 'status'
      }, [h('h3', t('connectionResults')), h('p', t(r.state)), table(['check', 'status', 'reason'], (r
        .checks || []).map(x => h('tr', [h('td', t(x.name)), h('td', pill(x.state)), h('td', [x
        .code || '—', x.httpStatus ? ' · HTTP ' + x.httpStatus : ''
      ])]))), h('p', {
        class: 'muted'
      }, t('connectionTestScope')), h('small', date(r.checkedAt))]);
    }

    function lifecycleResults() {
      const r = s.result?.lifecycle;
      if (!r) return null;
      return h('section', {
        class: 'card',
        role: 'status'
      }, [h('h3', t('lifecycleChecks')), h('p', t(r.persistence)), r.stage ? h('p', t(r.stage)) : null,
        r.code ? h('p', r.code) : null, table(['action', 'status', 'reason'], (r.options || []).map(x =>
          h('tr', [h('td', t(x.action)), h('td', t(x.available ? 'available' : 'unavailable')), h(
            'td', x.reason || '—')]))), h('p', {
          class: 'muted'
        }, t('lifecycleScope')), r.credentialId ? button('checkAgain', () => act(async () => {
          s.result = {
            ...s.result,
            lifecycle: await api(ocmPath('/credentials/' + encodeURIComponent(r.credentialId) +
              '/lifecycle'))
          };
        })) : button('credentials', () => change('credentials'))
      ]);
    }
    async function connect() {
      if (!s.me) return;
      socket?.disconnect();
      socket = window.io('/orce', {
        path: '/orce/socket.io',
        auth: {
          csrfToken: auth.csrfToken(),
          pathName: '/orce/',
          clientId: crypto.randomUUID()
        },
        transports: ['websocket'],
        reconnection: false
      });
      socket.on('connect', () => s.connected = true);
      socket.on('disconnect', () => s.connected = false);
      socket.on('connect_error', () => s.connected = false);
      socket.on('ui:hint', () => {
        if (!s.busy) load(true);
      });
    }
    const controller = {
      act,
      api,
      area,
      button,
      can,
      date,
      detail,
      download,
      input,
      lifecycleResults,
      load,
      mutate,
      pill,
      pre,
      s,
      select,
      t,
      table,
      ocmPath
    };
    onMounted(() => act(async () => {
      if (await auth.setup()) {
        s.me = await api('/auth/me');
        if (s.me.passwordChangeRequired) return;
        const prefs = await api('/preferences');
        if (['en', 'de', 'fr'].includes(prefs.locale)) s.locale = prefs.locale;
        document.documentElement.lang = s.locale;
        s.view = tabs.find(([v, p]) => can(p))?.[0] || 'health';
        await connect().catch(() => {
          s.connected = false;
        });
        let polling = false;
        timer = setInterval(async () => {
          if (!polling && !document.hidden && !s.busy && !s.detail && !['roles',
              'assignments', 'permissions', 'registry'
            ].includes(s.view)) {
            polling = true;
            try {
              await load(true);
            } finally {
              polling = false;
            }
          }
        }, 10000);
        refreshTimer = setInterval(() => act(async () => {
          s.me = await api('/auth/me');
          await connect();
        }), 60000);
        await load();
      }
    }));
    onUnmounted(() => {
      abort.abort();
      socket?.disconnect();
      clearInterval(timer);
      clearInterval(refreshTimer);
    });
    return () => h('div', {
      class: 'app-frame'
    }, [
      h('header', {
        class: s.me ? '' : 'signed-out'
      }, [h('div', {
        class: 'header-title'
      }, [button('menu', () => s.navOpen = !s.navOpen, 'menu-button'), h('div', [h('h1', t(
        'app')), h('small', t('subtitle'))
      ])]), h('div', {
        class: 'actions'
      }, [h('select', {
          'aria-label': t('locale'),
          value: s.locale,
          onChange: e => {
            s.locale = e.target.value;
            document.documentElement.lang = s.locale;
            if (s.me) act(() => api('/preferences', 'PATCH', {
              locale: s.locale
            }));
          }
        }, Object.keys(locales).map(l => h('option', {
          value: l
        }, l.toUpperCase()))), s.me ? button('changePassword', () => s.passwordEditing = true) :
        null, s.me ? button('logout', () => {
          abort.abort();
          socket?.disconnect();
          clearInterval(timer);
          clearInterval(refreshTimer);
          s.me = null;
          s.items = [];
          s.detail = null;
          s.result = null;
          s.claims = {};
          s.offer = '';
          auth.logout();
        }) : null
      ])]),
      (s.me?.passwordChangeRequired || s.passwordEditing) ? h('main', {
        class: 'welcome card'
      }, [h('h2', t('changePassword')), s.error ? h('p', {
        role: 'alert'
      }, t(s.error.code)) : null, input('currentPassword', s.currentPassword, v => s
        .currentPassword = v, 'password'), input('newPassword', s.newPassword, v => s.newPassword =
        v, 'password'), button('save', () => act(() => auth.changePassword(s.currentPassword, s
        .newPassword)), 'primary')]) : !s.me ? h('main', {
        class: 'welcome card'
      }, [h('img', {
        src: '/orce/facis-logo.svg',
        alt: 'FACIS',
        class: 'login-logo'
      }), h('h2', t('welcome')), s.error ? h('p', {
        role: 'alert'
      }, t('error')) : null, input('username', s.loginUsername, v => s.loginUsername = v), input(
        'password', s.loginPassword, v => s.loginPassword = v, 'password'), button('login', () =>
        act(() => auth.login(s.loginUsername, s.loginPassword)), 'primary')]) : h('div', {
        class: ['shell', s.navOpen ? 'nav-open' : '']
      }, [
        h('nav', {
          'aria-label': t('app')
        }, [h('div', {
          class: 'brand'
        }, [h('img', {
          src: '/orce/facis-logo.svg',
          alt: 'FACIS'
        }), h('span', 'Organizational Credential Manager')]), h('div', {
          class: 'nav-links'
        }, tabs.filter(([v, p]) => can(p)).map(([v]) => button(v, () => {
          s.navOpen = false;
          change(v);
        }, s.view === v ? 'active' : ''))), h('div', {
          class: 'nav-footer'
        }, [h('span', s.me.username || s.me.subject), h('small', 'OCM W-Stack · 12.5.11')])]),
        h('main', [h('div', {
            class: 'toolbar'
          }, [h('h2', t(s.view)), button('refresh', () => act(() => load()))]), !s.connected ? h(
            'p', {
              class: 'banner',
              role: 'status'
            }, t('degraded')) : null, s.error ? h('div', {
            class: 'banner error',
            role: 'alert'
          }, [h('strong', s.error.code === 'PERMISSION_DENIED' ? t('forbidden') : s.error.code ===
              'LAST_ROLE_MANAGER' ? t('lastManager') : t('error')), h('p', t(s.error.code)), s
            .error.httpStatus ? h('p', 'HTTP ' + s.error.httpStatus) : null, s.error.upstream ? h(
              'p', s.error.upstream + ' · HTTP ' + (s.error.upstreamStatus || '—') + (s.error
                .reason ? ' · ' + t(s.error.reason) : '')) : null, s.error.requestId ? h('small',
              t('requestId') + ': ' + s.error.requestId) : null
          ]) : null, s.notice ? h('p', {
            class: 'banner',
            role: 'status'
          }, s.notice) : null, s.busy ? h('p', {
            'aria-live': 'polite'
          }, t('loading')) : null,
          ...(s.view === 'credentials' ? credentials() : s.view === 'registry' ? registry() : s
            .view === 'clearing' ? clearing() : s.view === 'receive' ? receive() : s.view ===
            'issue' ? issue() : s.view === 'relationships' ? relationships() : s.view === 'roles' ?
            roles() : s.view === 'assignments' ? assignments() : s.view === 'permissions' ?
            permissionsPanel() : s.view === 'audit' ? [table(['time', 'user', 'action', 'outcome',
              'requestId'
            ], s.items.map(e => h('tr', [h('td', new Date(e.timestamp).toLocaleString(s
              .locale)), h('td', [e.actor?.username || e.subject || t('unknown'), h(
              'small', {
                class: 'row-id'
              }, e.actor?.subject || e.subject || '')]), h('td', e.action), h('td', t(e
                .outcome)), h('td', [e.requestId, e.action === 'issue' && can(
                'credentials.issue') ? button('inspectOperation', () => act(
          async () => {
                const job = await api('/issuance/' + encodeURIComponent(e
                  .requestId));
                s.view = 'issue';
                s.items = [];
                s.result = job;
                await load();
              })) : null])
            ])))] : health()), s.updated ? h('small', t('updated') + ': ' + s.updated
            .toLocaleString(s.locale)) : null
        ])
      ]), dialog()
    ]);
  }
};

createApp(App).mount('#app');
