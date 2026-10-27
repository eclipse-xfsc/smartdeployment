#!/usr/bin/env bash
# OCM W-Stack deployment node and standalone deployment command.
set -Eeuo pipefail
shopt -s inherit_errexit

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DEPLOYMENT="$ROOT/deployment"
export ESB_DEPLOY="$ROOT/deploy.sh"
if [[ ${1:-} != --internal ]]; then exec 3>&2; fi
source "$DEPLOYMENT/common.sh"
load_libraries
trap 'log_shell_error "$?" "$LINENO" "${BASH_SOURCE[0]:-$0}" "$BASH_COMMAND"' ERR

usage() {
    cat <<'HELP'
Usage: bash deploy.sh ACTION --config deployment.json --kubeconfig cluster.yaml [OPTIONS]

Actions:
  check              Check tools in the deployment container
  preflight          Validate configuration, certificates, sources and charts
  deploy             Install or resume the OCM W-Stack deployment
  repair-ocm         Reconcile native OCM services
  repair-network     Reconcile gateway configuration
  install-ui         Install the ORCE runtime and OCM W-Stack UI
  inspect            Read cluster state
  validate           Check cluster state and public endpoints
  diagnose-auth      Check the uploaded Kubernetes identity
  diagnose-api       Sample Kubernetes API readiness
  diagnose-storage   Check native Storage through the deployed runtime
  test-credentials   Exercise native issuance, retrieval and storage
  teardown           Remove this installation's tenant Helm release

Options:
  --credentials FILE              Node credential object (JSON)
  --runtime-credentials-file FILE Initial runtime credentials (JSON)
  --tls-cert-file FILE            TLS certificate chain (PEM)
  --tls-key-file FILE             Matching private key (PEM)
  --dns-token-file FILE           DNS provider API token
  --dns-secret-file FILE          Custom DNS provider Secret data (JSON)
  --confirm TEXT                 Explicit confirmation for test-credentials or teardown

Results are JSON on stdout. Progress events are JSON lines on stderr.
HELP
}

internal_action() {
    local action=${1:-}
    shift || true
    # Hooks inherit only the private operation directory and credential binding.
    # They never create a second deployment lease or remove the parent's files.
    if [[ $action == kube-command ]]; then kube_command "$@"; return; fi
    [[ -d ${WORKDIR:-} && -f ${CONFIG:-} && -f ${CREDENTIALS:-} ]] ||
        { printf 'Deployment operation context is unavailable.\n' >&2; return 1; }
    case "$action" in
        helm-upgrade) helm_upgrade "$@" ;;
        argo-install) argo_install ;;
        native-compatibility) cassandra_compatibility ;;
        prerequisites) native_prerequisites ;;
        startup) native_startup ;;
        argo-access) argo_access ;;
        gateway)
            case "${1:-}" in policy) gateway_policy ;; reconcile) gateway_reconcile ;; *) return 1 ;; esac ;;
        kube-read) kube_read "${1:?}" "$([[ ${2:-} == established ]] && printf true || printf false)" "${ESB_READ_TIMEOUT_SECONDS:-120}" ;;
        argo-health) argo_health "$([[ ${1:-} == --diagnose ]] && printf true || printf false)" ;;
        *) printf 'Unknown internal operation.\n' >&2; return 1 ;;
    esac
}

read_options() {
    ACTION=${1:-}
    [[ -n $ACTION ]] || { usage; exit 0; }
    shift
    if [[ $ACTION == --help || $ACTION == -h ]]; then usage; exit 0; fi
    if [[ $ACTION == check ]]; then check_tools; exit $?; fi
    case "$ACTION" in preflight|deploy|repair-ocm|repair-network|install-ui|inspect|validate|diagnose-auth|diagnose-api|diagnose-storage|test-credentials|teardown) ;;
        *) printf 'Unknown action: %s\n' "$ACTION" >&2; exit 1 ;; esac
    WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/esb-ocmwstack.XXXXXX")
    chmod 700 "$WORKDIR"
    OWNS_WORKDIR=true
    export WORKDIR CONFIG="$WORKDIR/config.json" CREDENTIALS="$WORKDIR/credentials.json"
    trap cleanup EXIT
    trap cancel INT TERM
    CONFIRM=''
    printf '{}\n' >"$CREDENTIALS"
    local input='' option key file
    local overlays=()
    while (($#)); do
        option=$1
        shift
        [[ $# -gt 0 ]] || { fail OPTIONS "Missing value for $option."; return 1; }
        case "$option" in
            --config) input=$1 ;;
            --credentials|--runtime-credentials-file)
                jq -e 'type=="object"' "$1" >/dev/null
                jq -s '.[0]+.[1]' "$CREDENTIALS" "$1" >"$WORKDIR/credentials-next.json"
                mv "$WORKDIR/credentials-next.json" "$CREDENTIALS" ;;
            --kubeconfig) overlays+=(kubeconfig "$1") ;;
            --tls-cert-file) overlays+=(tlsCertificate "$1") ;;
            --tls-key-file) overlays+=(tlsPrivateKey "$1") ;;
            --dns-token-file) overlays+=(dnsToken "$1") ;;
            --dns-secret-file) overlays+=(dnsSecretData "$1") ;;
            --confirm) CONFIRM=$1 ;;
            *) fail OPTIONS "Unknown option: $option"; return 1 ;;
        esac
        shift
    done
    [[ -f $input ]] || { fail CONFIG 'Supply --config with a deployment JSON file.'; return 1; }
    if [[ -z $CONFIRM ]]; then CONFIRM=$(jq -r '.confirm // empty' "$input"); fi
    while ((${#overlays[@]})); do
        key=${overlays[0]} file=${overlays[1]}
        jq --arg key "$key" --rawfile value "$file" '.[$key]=$value | if $key=="dnsToken" then .[$key]|=rtrimstr("\n") else . end' \
            "$CREDENTIALS" >"$WORKDIR/credentials-next.json"
        mv "$WORKDIR/credentials-next.json" "$CREDENTIALS"
        overlays=("${overlays[@]:2}")
    done
    if ! json_program normalize_config "$input" >"$CONFIG" 2>"$WORKDIR/config-error"; then
        fail CONFIG 'Deployment configuration is invalid; check the field requirements in README.md.'
        return 1
    fi
    TIMEOUT_SECONDS=$(config_value '.timeoutSeconds')
    export TIMEOUT_SECONDS ESB_TIMEOUT_SECONDS="$TIMEOUT_SECONDS" GIT_TERMINAL_PROMPT=0
    export HELM_QPS=5 HELM_BURST_LIMIT=10 HELM_CACHE_HOME="$WORKDIR/helm/cache"
    export HELM_CONFIG_HOME="$WORKDIR/helm/config" HELM_DATA_HOME="$WORKDIR/helm/data"
    check_tools >"$WORKDIR/tools.json" || { fail TOOLS 'A required deployment tool is unavailable; run deploy.sh check.'; return 1; }
}

wait_application_set() {
    (cd "$SOURCE" && run "$((TIMEOUT_SECONDS+30))" bash check-applicationset.sh "$1" argocd)
}

install_application_set() {
    local release=$1 file=$2 values=$3 namespace=${4:-infrastructure}
    local args=(upgrade --install "$release" "$SOURCE/XFSC/Applicationsets/chart"
        -f "$SOURCE/XFSC/Applicationsets/values/$file-values.yaml" -f "$values"
        --set-string "storageClass=$(config_value '.actualStorageClass')" -n "$namespace" --timeout "${TIMEOUT_SECONDS}s")
    if [[ $release == network ]]; then
        args+=(--set-string "profile=$(config_value '.profile')" --set-string "domain=$(config_value '.domain')" --set-string "email=$(config_value '.email')")
    fi
    helm_upgrade "$namespace" "$release" "${args[@]}"
}

operation() {
    bind_kubeconfig
    if [[ $ACTION == diagnose-api ]]; then diagnose_api; return; fi
    kube_identity
    if [[ $ACTION == diagnose-storage ]]; then storage_diagnostics; return; fi
    if [[ $ACTION == diagnose-auth ]]; then
        jq -n --slurpfile selection "$WORKDIR/selection.json" --slurpfile identity "$WORKDIR/identity.json" \
            '$selection[0]+{status:"authentication-checked",identity:$identity[0].status.userInfo}|del(.type)'
        return
    fi
    cluster_preflight
    case "$ACTION" in
        inspect) inspect_stack; return ;;
        validate) validate_stack; return ;;
        test-credentials) test_credentials; return ;;
        teardown)
            [[ $CONFIRM == "REMOVE TENANT $(config_value '.tenantRelease')" ]] ||
                { fail CONFIRM 'Confirm teardown with REMOVE TENANT followed by the tenant release name.'; return 1; }
            marker_matches || { fail OWNERSHIP 'Tenant removal requires this installation’s ownership marker.'; return 1; }
            acquire_lease
            verify_lease
            run "$((TIMEOUT_SECONDS+30))" helm uninstall "$(config_value '.tenantRelease')" -n ocm-wstack --ignore-not-found --timeout "${TIMEOUT_SECONDS}s"
            update_marker '{"state":"tenant-removed"}'
            jq '{status:"tenant-removed",tenantRelease,retained:["OCM services","Argo CD","shared infrastructure","credential data","OpenBao tenant keys","signer registration"]}' "$CONFIG"
            return ;;
    esac
    tls_preflight
    [[ $ACTION == repair-network ]] || runtime_preflight
    checkout_source
    prepare_charts
    if [[ $ACTION == preflight ]]; then cat "$WORKDIR/chart-report.json"; return; fi
    if [[ $ACTION == repair-* || $ACTION == install-ui ]]; then
        marker_matches || { fail OWNERSHIP 'This action requires the matching installation marker.'; return 1; }
    fi
    acquire_lease
    ensure_marker
    update_marker "$(jq '{validatedArgoRevision:.argoRevision,validatedChartCount:(.charts|length|tostring),argoManifestSha256}' "$WORKDIR/chart-report.json")"
    write_values
    if [[ $ACTION == install-ui ]]; then
        jq -e '.data.bootstrapComplete=="true"' "$WORKDIR/marker.json" >/dev/null ||
            { fail OWNERSHIP 'Complete the native bootstrap before installing the UI.'; return 1; }
        tls_install
        native_routing
        wait_tenant_tls
        runtime_install
        validate_stack
        return
    fi
    if [[ $ACTION == repair-network ]] || jq -e '.data.bootstrapComplete=="true"' "$WORKDIR/marker.json" >/dev/null; then
        phase gateway-compatibility
        permit_dns_repository
        [[ -z $ESB_DNS_SECRET_FILE ]] || apply_json "$ESB_DNS_SECRET_FILE"
        gateway_policy
        install_application_set network 04_network "$WORKDIR/network-values.json"
        wait_application_set network
        gateway_reconcile
        if [[ $ACTION == repair-network ]]; then inspect_stack; return; fi
        install_application_set storage 03_storage "$WORKDIR/core-values.json"
        wait_application_set storage
        install_application_set core 05_core "$WORKDIR/core-values.json"
        wait_application_set core
    fi
    if [[ $ACTION == repair-ocm ]] || jq -e '.data.bootstrapComplete=="true"' "$WORKDIR/marker.json" >/dev/null; then
        local state name
        state=$(release_status ocm-wstack ocm-wstack)
        [[ $state == deployed || $state == failed ]] || { fail HELM_STATE_UNAVAILABLE 'OCM release is unavailable.'; return 1; }
        for name in storage network core; do wait_application_set "$name"; done
        phase repair-ocm
        native_prerequisites
        install_application_set ocm-wstack 06_ocm_wstack "$WORKDIR/ocm-values.json" ocm-wstack
        native_startup
        wait_application_set ocm-wstack
    else
        phase bootstrap
        update_marker '{"state":"bootstrapping"}'
        local args=(ocm-wstack-init.sh --profile "$(config_value '.profile')" --domain "$(config_value '.domain')" --email "$(config_value '.email')")
        [[ $(config_value '.externalDns') == true ]] || args+=(--disable-external-dns)
        (cd "$SOURCE" && run "$((TIMEOUT_SECONDS*12<86400 ? TIMEOUT_SECONDS*12 : 86400))" bash "${args[@]}")
    fi
    verify_lease
    update_marker '{"bootstrapComplete":"true","ocmCompatibility":"12.4.0","state":"tenant"}'
    native_routing
    phase tenant
    tls_install
    helm_upgrade ocm-wstack "$(config_value '.tenantRelease')" upgrade --install "$(config_value '.tenantRelease')" \
        "$SOURCE/XFSC/tenant/chart" -f "$SOURCE/XFSC/tenant/values/tenant-ocm-wstack-values.yaml" -f "$WORKDIR/tenant-values.json" \
        -n ocm-wstack --timeout "${TIMEOUT_SECONDS}s"
    update_marker '{"state":"installed"}'
    native_routing
    wait_tenant_tls
    runtime_install
    dashboard_install
    phase native-validation
    wait_validation >"$WORKDIR/result.json"
    if jq -e 'any(.ui.checks[0].dependencies[]?;.name=="storage" and .ok==false)' "$WORKDIR/result.json" >/dev/null; then
        if storage_diagnostics >"$WORKDIR/diagnostics.json"; then
            jq --slurpfile diagnostic "$WORKDIR/diagnostics.json" '.storageDiagnostics=$diagnostic[0]' "$WORKDIR/result.json" >"$WORKDIR/result-next.json"
            mv "$WORKDIR/result-next.json" "$WORKDIR/result.json"
        fi
    fi
    update_marker "$(jq '{state:.status}' "$WORKDIR/result.json")"
    cat "$WORKDIR/result.json"
}

main() {
    if [[ ${1:-} == --internal ]]; then
        shift
        internal_action "$@"
        return
    fi
    # Keep the result channel outside operation and hook output redirections.
    exec 4>&1
    RESULT_FD=4
    read_options "$@"
    operation >"$WORKDIR/final-result.json"
    jq -e -s 'length==1 and (.[0]|type=="object")' "$WORKDIR/final-result.json" >/dev/null ||
        { fail ACTION_RESULT "Deployment action ended without exactly one JSON result."; return 1; }
    cat "$WORKDIR/final-result.json"
    RESULT_WRITTEN=true
    if jq -e '.status|IN("failed","action-required","api-unreliable")' "$WORKDIR/final-result.json" >/dev/null; then return 2; fi
    return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
