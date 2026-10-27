#!/usr/bin/env bash
# Uploaded Kubernetes identity, ownership, bootstrap and Helm operations.

MARKER=esb-ocmwstack-v12
LEASE=esb-ocmwstack-v12

bind_kubeconfig() {
    local variable
    for variable in ${!HELM_KUBE@} ${!ESB_KUBE@}; do
        unset "$variable"
    done
    ESB_REAL_KUBECTL=$(command -v kubectl)
    ESB_REAL_HELM=$(command -v helm)
    [[ $ESB_REAL_KUBECTL == /* && $ESB_REAL_HELM == /* ]] ||
        fail KUBE_EXECUTABLE 'kubectl and Helm must resolve to absolute executable paths.'
    export ESB_REAL_KUBECTL ESB_REAL_HELM

    ESB_KUBECONFIG="$WORKDIR/kubeconfig"
    credential_file kubeconfig "$ESB_KUBECONFIG"
    export ESB_KUBECONFIG KUBECONFIG="$ESB_KUBECONFIG"
    run_capture "$WORKDIR/kube-selection.json" 15 "$ESB_REAL_KUBECTL" \
        --kubeconfig "$ESB_KUBECONFIG" config view --minify -o json
    if ! jq -e '
        . as $doc |
        [.contexts[]? | select(.name == $doc["current-context"])][0] as $context |
        [$doc.users[]? | select(.name == $context.context.user)][0].user as $user |
        [$doc.clusters[]? | select(.name == $context.context.cluster)][0].cluster as $cluster |
        $context.context.user != null and $context.context.cluster != null and
        $cluster.server != null and $user != null and
        ($user.tokenFile // $user["client-certificate"] // $user["client-key"] // $cluster["certificate-authority"] // null) == null and
        (($user["client-certificate-data"] != null and $user["client-key-data"] != null) or
         ($user.token // "" | length > 0) or $user.exec.command != null or $user["auth-provider"].name != null)
    ' "$WORKDIR/kube-selection.json" >/dev/null; then
        fail KUBECONFIG_CONTEXT 'Upload a self-contained kubeconfig with an explicit current context and credentials.'
        return 1
    fi
    ESB_KUBE_CONTEXT=$(jq -r '.["current-context"]' "$WORKDIR/kube-selection.json")
    export ESB_KUBE_CONTEXT
    mkdir "$WORKDIR/kube-bin"
    local command
    for command in kubectl helm; do
        cat >"$WORKDIR/kube-bin/$command" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec bash "${ESB_DEPLOY:?}" --internal kube-command "${0##*/}" "$@"
SH
        chmod 700 "$WORKDIR/kube-bin/$command"
    done
    export PATH="$WORKDIR/kube-bin:$PATH"
    jq -n --slurpfile doc "$WORKDIR/kube-selection.json" \
        --arg digest "$(sha256sum "$ESB_KUBECONFIG" | cut -d ' ' -f 1)" '
        $doc[0] as $d | $d.contexts[0] as $c | $d.users[0].user as $u |
        {type:"kubeconfig-selection",source:"editor-upload",context:$c.name,
         user:$c.context.user,cluster:$c.context.cluster,server:$d.clusters[0].cluster.server,
         authentication:(if $u["client-certificate-data"] then "client-certificate" elif $u.token then "token" elif $u.exec then "exec-plugin" else "auth-provider" end),
         kubeconfigSha256:$digest}' >"$WORKDIR/selection.json"
    emit "$(cat "$WORKDIR/selection.json")"
}

kube_command() {
    local command=$1 argument executable context_flag
    shift
    [[ -r ${ESB_KUBECONFIG:-} && ${ESB_KUBECONFIG:-} == /* && -n ${ESB_KUBE_CONTEXT:-} ]] ||
        { printf 'Uploaded kubeconfig binding is unavailable.\n' >&2; return 1; }
    case "$command" in
        kubectl) executable=$ESB_REAL_KUBECTL; context_flag=--context ;;
        helm) executable=$ESB_REAL_HELM; context_flag=--kube-context ;;
        *) return 1 ;;
    esac
    [[ $executable == /* ]] || return 1
    for argument in "$@"; do
        case "$argument" in
            --kubeconfig|--kubeconfig=*|--context|--context=*|--user|--user=*|--cluster|--cluster=*|--server|--server=*|--token|--token=*|--as|--as=*|--as-group|--as-group=*|--as-uid|--as-uid=*|--client-certificate|--client-certificate=*|--client-key|--client-key=*|--kube-context|--kube-context=*|--kube-token|--kube-token=*|--kube-apiserver|--kube-apiserver=*|--kube-as-user|--kube-as-user=*|--kube-as-group|--kube-as-group=*|--kube-ca-file|--kube-ca-file=*|-s|-s?*)
                printf 'Kubernetes credential and context overrides are not allowed.\n' >&2
                return 1 ;;
        esac
    done
    exec "$executable" --kubeconfig "$ESB_KUBECONFIG" "$context_flag" "$ESB_KUBE_CONTEXT" "$@"
}

kube_identity() {
    kube_json "$WORKDIR/identity.json" auth whoami -o json
    local actual
    actual=$(jq -er '.status.userInfo.username | select(length > 0)' "$WORKDIR/identity.json")
    if [[ -n ${ESB_KUBE_USERNAME:-} && $actual != "$ESB_KUBE_USERNAME" ]]; then
        fail KUBE_IDENTITY_CHANGED 'Kubernetes authenticated as a different identity.'
        return 1
    fi
    export ESB_KUBE_USERNAME="$actual"
    emit "$(jq -c '.status.userInfo | {type:"kubeconfig-identity",username,groups:(.groups // [])}' "$WORKDIR/identity.json")"
}

access_review() {
    local attributes=$1
    jq -n --argjson attributes "$attributes" \
        '{apiVersion:"authorization.k8s.io/v1",kind:"SelfSubjectAccessReview",spec:{resourceAttributes:$attributes}}' >"$WORKDIR/access-request.json"
    kube_json "$WORKDIR/access-response.json" create \
        --raw=/apis/authorization.k8s.io/v1/selfsubjectaccessreviews \
        -f "$WORKDIR/access-request.json" --request-timeout=15s
    jq -e '.status.allowed == true and .status.denied != true' "$WORKDIR/access-response.json" >/dev/null ||
        fail RBAC 'The uploaded Kubernetes identity does not have the required permissions.'
    emit "$(jq -cn --arg username "$ESB_KUBE_USERNAME" --argjson attributes "$attributes" \
        '{type:"kube-access",phase:"preflight",username:$username,attributes:$attributes,allowed:true}')"
}

argo_access() {
    kube_identity
    local resource verb
    for resource in applications applicationsets appprojects; do
        if [[ $resource == applications ]]; then
            for verb in get list; do
                access_review "$(jq -cn --arg resource "$resource" --arg verb "$verb" \
                    '{group:"argoproj.io",resource:$resource,verb:$verb,namespace:"argocd"}')"
            done
        else
            access_review "$(jq -cn --arg resource "$resource" \
                '{group:"argoproj.io",resource:$resource,verb:"*",namespace:"argocd"}')"
        fi
    done
}

cluster_preflight() {
    phase preflight
    access_review '{"group":"*","resource":"*","verb":"*"}'
    argo_access
    kube_json "$WORKDIR/nodes.json" get nodes -o json
    kube_json "$WORKDIR/classes.json" get storageclasses -o json
    kube_json "$WORKDIR/cluster.json" get namespace kube-system -o json
    jq -e 'any(.items[]; .spec.unschedulable != true and any(.status.conditions[]?; .type == "Ready" and .status == "True"))' \
        "$WORKDIR/nodes.json" >/dev/null || fail NO_READY_NODES 'No schedulable Ready node was found.'
    run_capture "$WORKDIR/helm-version" 15 helm version --short
    [[ $(cat "$WORKDIR/helm-version") =~ ^v[34]\. ]] || fail HELM_VERSION 'Use Helm 3 or 4.'
    json_program 'resolve_config($nodes[0];$classes[0];$credentials[0])' \
        --slurpfile nodes "$WORKDIR/nodes.json" --slurpfile classes "$WORKDIR/classes.json" \
        --slurpfile credentials "$CREDENTIALS" "$CONFIG" >"$WORKDIR/resolved.json"
    mv "$WORKDIR/resolved.json" "$CONFIG"
    update_config '.clusterUid=$uid' --arg uid "$(jq -er '.metadata.uid' "$WORKDIR/cluster.json")"
    get_optional "$WORKDIR/marker.json" kube-system configmap "$MARKER"
    local owner
    owner=$(jq -r 'if . == null then empty else .data.dnsOwnerId // "xfsc" end' "$WORKDIR/marker.json")
    update_config '.dnsOwnerId=$owner' --arg owner "${owner:-esb-$(config_value '.clusterUid')}"
    emit "$(jq -c '{type:"detected",provider:.actualProvider,detectedProvider,storageClass:.actualStorageClass,
        dnsProvider:.actualDns,locations:.providerLocations,zones:.providerZones,
        providerEvidence,externalTrafficPolicy}' "$CONFIG")"
}

# Classify command failures without forwarding response bodies or credentials.
api_failure_reason() {
    local file=$1 status=${2:-0} timed_out=${3:-${LAST_TIMEOUT:-false}}
    if grep -Eiq 'unauthorized|authentication required|must be logged in|provide credentials|getting credentials' "$file"; then printf authentication;
    elif grep -Eiq 'forbidden|access denied' "$file"; then printf authorization;
    elif grep -Eiq 'x509:|certificate verify|certificate signed by unknown|tls:.*certificate' "$file"; then printf certificate;
    elif grep -Eiq 'kubeconfig binding is unavailable|credential and context overrides|context .*does not exist' "$file"; then printf kubeconfig;
    elif grep -Eiq 'another operation|pending-(install|upgrade|rollback)' "$file"; then printf helm-pending;
    elif grep -Eiq 'invalid:|validation failed|immutable|exceeded quota|nil pointer|template:|parse error' "$file"; then printf validation;
    elif grep -Eiq 'command not found|unbound variable|bad file descriptor|argument list too long|cannot execute|permission denied' "$file" || [[ $status == 126 || $status == 127 ]]; then printf local-command;
    elif [[ $status == 124 || $timed_out == true && ( $status == 137 || $status == 143 ) ]]; then printf process-timeout;
    elif [[ $status == 137 || $status == 143 ]]; then printf process-terminated;
    elif grep -Eiq 'no such host|temporary failure in name resolution|server misbehaving|resolving timed out' "$file"; then printf dns;
    elif grep -Eiq 'context deadline exceeded|request canceled.*(timeout|deadline)|timeout exceeded while awaiting headers|client rate limiter.*deadline|i/o timeout|TLS handshake timeout|net/http: request canceled|timed out waiting for the condition|Error from server \(ServerTimeout\)|Error from server \(Timeout\)|Timeout occurred|server was unable to return a response in the time allotted' "$file"; then printf request-timeout;
    elif grep -Eiq 'connection reset|connection refused|http2: client connection lost|unexpected EOF|(^|[ :])EOF($|[[:space:]])|network is unreachable|no route to host|broken pipe' "$file"; then printf connection;
    elif grep -Eiq 'too many requests|TooManyRequests' "$file"; then printf rate-limited;
    elif grep -Eiq 'ServiceUnavailable|server is currently unable to handle|InternalError|Internal Server Error|Bad Gateway|Gateway Timeout' "$file"; then printf api-unavailable;
    else printf unclassified; fi
}

retryable_api_reason() {
    case "$1" in process-timeout|request-timeout|dns|connection|rate-limited|api-unavailable) return 0 ;; *) return 1 ;; esac
}

transport_failure() {
    retryable_api_reason "$(api_failure_reason "$1" "${2:-${LAST_STATUS:-0}}")"
}

# A history entry contains only operation metadata and a classified reason.
# Keep the Helm failure even when a later readiness check also fails.
record_api_failure() {
    local step=$1 namespace=$2 release=$3 attempt=$4 attempts=$5 reason=$6 retryable=false
    retryable_api_reason "$reason" && retryable=true
    [[ -f $WORKDIR/api-failures.json ]] || printf '[]\n' >"$WORKDIR/api-failures.json"
    local server=''
    if [[ -f $WORKDIR/selection.json ]]; then
        server=$(jq -r '.server // ""' "$WORKDIR/selection.json")
    fi
    # Server authority comes from the uploaded kubeconfig; omit URL credentials.
    server=$(node -e 'try { const u=new URL(process.argv[1]); console.log(u.origin); } catch {}' "$server")
    jq -cn --arg step "$step" --arg namespace "$namespace" --arg release "$release" \
        --arg apiServer "$server" --arg reason "$reason" --arg at "$(timestamp)" \
        --argjson exitCode "${LAST_STATUS:-1}" --argjson attempt "$attempt" \
        --argjson attempts "$attempts" --argjson retryable "$retryable" \
        '{step:$step,namespace:$namespace,release:$release,apiServer:$apiServer,reason:$reason,
          exitCode:$exitCode,attempt:$attempt,attempts:$attempts,retryable:$retryable,at:$at}
         + (if $step=="api-readiness" then {path:"/readyz"} else {} end)' >"$WORKDIR/api-diagnostic.json"
    jq --slurpfile entry "$WORKDIR/api-diagnostic.json" '. + $entry | .[-20:]' \
        "$WORKDIR/api-failures.json" >"$WORKDIR/api-failures-next.json"
    mv "$WORKDIR/api-failures-next.json" "$WORKDIR/api-failures.json"
    emit "$(jq -c '{type:"command-failure",phase:.release,diagnostic:.}' "$WORKDIR/api-diagnostic.json")"
}

fail_api_command() {
    local code=$1 message=$2
    jq -cn --arg code "$code" --arg message "$message" \
        --slurpfile history "$WORKDIR/api-failures.json" \
        '{status:"failed",code:$code,message:$message,diagnostics:{history:$history[0]}}' >"$WORKDIR/error.json"
    return 1
}

wait_api_ready() {
    local namespace=$1 release=$2 attempt reason delay
    for attempt in 1 2 3 4 5; do
        if run_capture "$WORKDIR/api-ready" 12 kubectl get --raw=/readyz --request-timeout=10s; then
            # kubectl returns success for HTTP 2xx; readiness is an HTTP contract.
            return 0
        else
            LAST_STATUS=$?
        fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        record_api_failure api-readiness "$namespace" "$release" "$attempt" 5 "$reason"
        if ! retryable_api_reason "$reason" || ((attempt == 5)); then
            fail_api_command API_UNREADY "Kubernetes API readiness failed for $namespace/$release: $reason (exit $LAST_STATUS, check $attempt/5)."
            return 1
        fi
        delay=$((attempt < 4 ? 2**attempt : 8))
        emit "$(jq -cn --arg phase "$release" --arg reason "$reason" --argjson attempt "$((attempt+1))" \
            --argjson delay "$delay" '{type:"retry",phase:$phase,step:"api-readiness",reason:$reason,attempt:$attempt,attempts:5,delaySeconds:$delay}')"
        sleep "$delay"
    done
}

lease_valid() {
    jq -e --arg holder "$ESB_LEASE_HOLDER" --argjson now "$(date +%s)" '
        .spec.holderIdentity == $holder and
        (((.spec.renewTime // .spec.acquireTime) | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601)
         + (.spec.leaseDurationSeconds // 180) > $now + 15)' "$1" >/dev/null
}

verify_lease() {
    [[ -n ${ESB_LEASE_HOLDER:-} ]] || { fail LEASE_LOST 'No deployment lease identity is available.'; return 1; }
    kube_json "$WORKDIR/lease-check.json" -n kube-system get lease "$LEASE" -o json --request-timeout=10s || return 1
    lease_valid "$WORKDIR/lease-check.json" || fail LEASE_LOST 'The deployment lease expired or belongs to another operation.'
}

acquire_lease() {
    get_optional "$WORKDIR/lease.json" kube-system lease "$LEASE"
    if jq -e --argjson now "$(date +%s)" '
        . != null and (.spec.holderIdentity // "") != "" and
        (((.spec.renewTime // .spec.acquireTime) | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601)
          + (.spec.leaseDurationSeconds // 180) > $now)' "$WORKDIR/lease.json" >/dev/null; then
        fail BUSY 'Another deployment holds this cluster lease.'
        return 1
    fi
    export ESB_LEASE_HOLDER
    ESB_LEASE_HOLDER=$(openssl rand -hex 16)
    local operation=create
    jq -e '. != null' "$WORKDIR/lease.json" >/dev/null && operation=replace
    jq --arg name "$LEASE" --arg holder "$ESB_LEASE_HOLDER" \
        --arg now "$(date -u '+%Y-%m-%dT%H:%M:%S.000000Z')" '
        {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
         metadata:({name:$name,namespace:"kube-system"} +
                   (if .metadata.resourceVersion then {resourceVersion:.metadata.resourceVersion} else {} end)),
         spec:{holderIdentity:$holder,leaseDurationSeconds:180,acquireTime:$now,renewTime:$now}}
    ' "$WORKDIR/lease.json" >"$WORKDIR/lease-new.json"
    kube_json "$WORKDIR/lease.json" -n kube-system "$operation" -f "$WORKDIR/lease-new.json" -o json
    local parent=$BASHPID
    (
        trap - EXIT ERR
        local pause=''
        trap '[[ -z $pause ]] || kill "$pause" 2>/dev/null || true; [[ -z $CURRENT_PID ]] || kill -TERM "$CURRENT_PID" 2>/dev/null || true; exit 0' TERM INT
        while :; do
            sleep 45 &
            pause=$!
            wait "$pause" || exit 0
            pause=''
            if ! renew_lease; then
                jq -cn '{status:"failed",code:"LEASE_LOST",message:"Lease renewal failed; deployment stopped."}' >"$WORKDIR/error.json"
                touch "$WORKDIR/lease-lost"
                kill -TERM "$parent"
                exit 1
            fi
        done
    ) >&3 2>&3 &
    LEASE_PID=$!
}

renew_lease() {
    local attempt
    for attempt in 1 2 3; do
        if run_capture "$WORKDIR/lease-renew.json" 12 kubectl -n kube-system get lease "$LEASE" -o json --request-timeout=10s; then
            lease_valid "$WORKDIR/lease-renew.json" || return 1
            jq --arg now "$(date -u '+%Y-%m-%dT%H:%M:%S.000000Z')" '.spec.renewTime=$now' \
                "$WORKDIR/lease-renew.json" >"$WORKDIR/lease-renew-next.json" || return 1
            if run_capture "$WORKDIR/lease-renewed.json" 12 kubectl -n kube-system replace -f "$WORKDIR/lease-renew-next.json" -o json --request-timeout=10s; then
                return 0
            fi
        fi
        transport_failure "$LAST_ERROR" || return 1
        sleep "$((attempt * 2))"
    done
    return 1
}

release_lease() {
    run_capture "$WORKDIR/lease-release.json" 12 kubectl -n kube-system get lease "$LEASE" -o json --request-timeout=10s || return 1
    jq -e --arg holder "$ESB_LEASE_HOLDER" '.spec.holderIdentity == $holder' "$WORKDIR/lease-release.json" >/dev/null || return 0
    jq '.spec.holderIdentity=""' "$WORKDIR/lease-release.json" >"$WORKDIR/lease-release-next.json"
    run_capture "$WORKDIR/lease-released.json" 12 kubectl -n kube-system replace -f "$WORKDIR/lease-release-next.json" --request-timeout=10s
}

release_status() {
    local namespace=$1 release=$2
    if ! run_capture "$WORKDIR/helm-state.json" 30 helm status "$release" -n "$namespace" -o json; then
        if grep -qi 'release: not found' "$LAST_ERROR"; then
            printf 'absent\n'
            return
        fi
        fail HELM_STATE_UNAVAILABLE 'Cannot establish the Helm release state.'
        return 1
    fi
    local status
    status=$(jq -er '.info.status' "$WORKDIR/helm-state.json")
    case "$status" in
        deployed|failed|absent) printf '%s\n' "$status" ;;
        pending-*|uninstalling) fail HELM_PENDING "Helm release $namespace/$release is $status." ;;
        *) fail HELM_STATE_UNAVAILABLE 'Helm returned an unsupported release state.' ;;
    esac
}

helm_upgrade() {
    local namespace=$1 release=$2
    shift 2
    [[ ${1:-} == upgrade && " $* " == *' --install '* ]] ||
        { fail HELM_COMMAND 'Expected helm upgrade --install.'; return 1; }
    local attempt state reason
    printf '[]\n' >"$WORKDIR/api-failures.json"
    for attempt in 1 2 3; do
        if ((attempt > 1)); then
            emit "$(jq -cn --arg phase "$release" --argjson attempt "$attempt" '{type:"retry",phase:$phase,attempt:$attempt,attempts:3}')"
            sleep "$((attempt == 2 ? 5 : 15))"
        fi
        wait_api_ready "$namespace" "$release" || return 1
        if ! release_status "$namespace" "$release" >"$WORKDIR/release-status"; then
            transport_failure "$LAST_ERROR" && continue
            return 1
        fi
        state=$(cat "$WORKDIR/release-status")
        if ! verify_lease; then
            transport_failure "$LAST_ERROR" && continue
            return 1
        fi
        emit "$(jq -cn --arg namespace "$namespace" --arg release "$release" --arg status "$state" --argjson attempt "$attempt" \
            '{type:"helm-state",namespace:$namespace,release:$release,status:$status,attempt:$attempt}')"
        if run_capture "$WORKDIR/helm-output" "$((TIMEOUT_SECONDS + 30))" helm "$@"; then
            if ! release_status "$namespace" "$release" >"$WORKDIR/release-status"; then
                transport_failure "$LAST_ERROR" && continue
                return 1
            fi
            state=$(cat "$WORKDIR/release-status")
            [[ $state == deployed ]] || { fail HELM_STATE_UNAVAILABLE 'Helm did not confirm a deployed release.'; return 1; }
            return 0
        fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        record_api_failure helm-upgrade "$namespace" "$release" "$attempt" 3 "$reason"
        if ! retryable_api_reason "$reason"; then
            fail_api_command COMMAND_FAILED "Helm upgrade failed for $namespace/$release: $reason (exit $LAST_STATUS)."
            return 1
        fi
    done
    if [[ -s $WORKDIR/api-diagnostic.json ]]; then
        fail_api_command API_TRANSPORT "Kubernetes operation failed for $namespace/$release after three attempts: $(jq -r '.reason' "$WORKDIR/api-diagnostic.json")."
    else
        fail API_TRANSPORT 'Kubernetes transport failed after three Helm attempts; release records are retained.'
    fi
}

marker_matches() {
    jq -e --slurpfile c "$CONFIG" '
        .data.instance == $c[0].instanceName and .data.clusterUid == $c[0].clusterUid and
        .data.tenantId == $c[0].tenantId and .data.tenantRelease == $c[0].tenantRelease and
        .data.tenantHost == $c[0].tenantHost and
        (.data.storageClass == null or .data.storageClass == $c[0].actualStorageClass) and
        .metadata.labels["app.kubernetes.io/managed-by"] == "esb-ocmwstack"
    ' "$WORKDIR/marker.json" >/dev/null
}

ensure_marker() {
    get_optional "$WORKDIR/marker.json" kube-system configmap "$MARKER"
    if jq -e '. != null' "$WORKDIR/marker.json" >/dev/null; then
        marker_matches || { fail OWNERSHIP 'The installation marker belongs to another cluster or tenant configuration.'; return 1; }
        jq -e --slurpfile lock "$ROOT/upstream-lock.json" '.data.upstreamCommit as $sha | ($lock[0].compatibleBootstrapCommits + [$lock[0].commit]) | index($sha) != null' \
            "$WORKDIR/marker.json" >/dev/null || { fail UPSTREAM_COMMIT 'The installation uses an incompatible bootstrap revision.'; return 1; }
        return
    fi
    kube_json "$WORKDIR/namespaces.json" get namespaces -o json
    jq -e 'all(.items[]; .metadata.name | IN("observability","security","argocd","infrastructure","ocm-wstack") | not)' \
        "$WORKDIR/namespaces.json" >/dev/null || { fail NOT_FRESH 'Upstream namespaces already exist without this installation marker.'; return 1; }
    local digest
    digest=$(jq -Sc 'del(.dnsSecret,.timeoutSeconds)' "$CONFIG" | sha256sum | cut -d ' ' -f 1)
    jq -n --slurpfile c "$CONFIG" --slurpfile package "$ROOT/package.json" --slurpfile lock "$ROOT/upstream-lock.json" \
        --arg name "$MARKER" --arg digest "$digest" --arg now "$(timestamp)" '
        $c[0] as $c | {apiVersion:"v1",kind:"ConfigMap",
        metadata:{name:$name,namespace:"kube-system",labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},
        data:{instance:$c.instanceName,fingerprint:$digest,clusterUid:$c.clusterUid,upstreamCommit:$lock[0].commit,
              storageClass:$c.actualStorageClass,packageVersion:$package[0].version,state:"initializing",createdAt:$now,
              tenantRelease:$c.tenantRelease,tenantId:$c.tenantId,tenantHost:$c.tenantHost,dnsOwnerId:$c.dnsOwnerId}}' >"$WORKDIR/marker-new.json"
    kube_json "$WORKDIR/marker.json" create -f "$WORKDIR/marker-new.json" -o json
}

update_marker() {
    local data=$1
    kube_json "$WORKDIR/marker.json" -n kube-system get configmap "$MARKER" -o json
    marker_matches || { fail OWNERSHIP 'Installation ownership changed.'; return 1; }
    jq --argjson data "$data" --arg now "$(timestamp)" '.data += ($data + {updatedAt:$now})' \
        "$WORKDIR/marker.json" >"$WORKDIR/marker-next.json"
    kube_json "$WORKDIR/marker.json" replace -f "$WORKDIR/marker-next.json" -o json
}

checkout_source() {
    phase upstream-source
    SOURCE="$WORKDIR/deployment"
    export SOURCE
    local repository revision name expected actual
    repository=$(jq -r '.repository' "$ROOT/upstream-lock.json")
    revision=$(jq -r '.commit' "$ROOT/upstream-lock.json")
    [[ $revision =~ ^[a-f0-9]{40}$ && $revision == "$(jq -r '.argoRevision' "$ROOT/upstream-lock.json")" ]] ||
        { fail UPSTREAM_COMMIT 'Bootstrap and ApplicationSets must use the same pinned commit.'; return 1; }
    export ESB_DEPLOYMENT_REVISION="$revision"
    run 30 git init --quiet "$SOURCE"
    run 30 git -C "$SOURCE" remote add origin "$repository"
    run 300 git -C "$SOURCE" fetch --depth=1 origin "$revision"
    run 30 git -C "$SOURCE" checkout --quiet --detach FETCH_HEAD
    actual=$(git -C "$SOURCE" rev-parse HEAD)
    [[ $actual == "$revision" ]] || fail UPSTREAM_COMMIT 'Downloaded bootstrap revision differs from the lock.'
    while IFS=$'\t' read -r name expected; do
        actual=$(sha256sum "$SOURCE/$name" | cut -d ' ' -f 1)
        [[ $actual == "$expected" ]] || { fail UPSTREAM_CONTRACT "Upstream file changed: $name"; return 1; }
    done < <(jq -r '.sha256 | to_entries[] | [.key,.value] | @tsv' "$ROOT/upstream-lock.json")
    run 30 git -C "$SOURCE" apply --check "$DEPLOYMENT/upstream.patch"
    run 30 git -C "$SOURCE" apply "$DEPLOYMENT/upstream.patch"
}

# Helm parses YAML for both preflight and installation. The reader chart has no
# dependencies and never contacts Kubernetes or creates resources.
read_yaml() {
    local documents=$1 output=$2
    local parser="$WORKDIR/yaml-reader"
    mkdir -p "$parser/templates"
    printf 'apiVersion: v2\nname: esb-yaml-reader\nversion: 1.0.0\n' >"$parser/Chart.yaml"
    cat >"$parser/templates/documents.yaml" <<'HELM'
{{- $result := dict -}}
{{- range $name, $text := .Values.documents -}}
{{- $parsed := fromYaml $text -}}
{{- if hasKey $parsed "Error" -}}{{ fail (printf "%s: %s" $name $parsed.Error) }}{{- end -}}
{{- $_ := set $result $name $parsed -}}
{{- end -}}
{{ $result | toJson }}
HELM
    jq '{documents:.}' "$documents" >"$WORKDIR/yaml-input.json"
    run_capture "$WORKDIR/yaml-output.txt" 30 helm template esb-yaml-reader "$parser" -f "$WORKDIR/yaml-input.json"
    sed -n '/^{/,$p' "$WORKDIR/yaml-output.txt" >"$output"
    jq -e 'type=="object"' "$output" >/dev/null || fail YAML_RESPONSE 'Helm YAML reader returned no object.'
}

write_values() {
    json_program 'network_values($lock[0])' --slurpfile lock "$ROOT/upstream-lock.json" "$CONFIG" >"$WORKDIR/network-values.json"
    json_program 'template_values($c[0])' --slurpfile c "$CONFIG" "$DEPLOYMENT/templates/native-overrides.json" >"$WORKDIR/native-overrides.json"
    json_program 'native_values($lock[0];$overrides[0];$routing)' --slurpfile lock "$ROOT/upstream-lock.json" \
        --slurpfile overrides "$WORKDIR/native-overrides.json" --rawfile routing "$DEPLOYMENT/templates/routing-patch.yaml" \
        "$CONFIG" >"$WORKDIR/ocm-values.json"
    jq -n --slurpfile lock "$ROOT/upstream-lock.json" --rawfile patch "$DEPLOYMENT/templates/routing-patch.yaml" \
        '{tag:$lock[0].argoRevision,esbTemplatePatch:$patch}' >"$WORKDIR/core-values.json"
    json_program 'template_values($c[0])' --slurpfile c "$CONFIG" "$DEPLOYMENT/templates/observability.json" >"$WORKDIR/observability-values.json"
    json_program 'network_overrides($lock[0])' --slurpfile lock "$ROOT/upstream-lock.json" "$CONFIG" >"$WORKDIR/network-overrides.json"
    jq -s '.[0]+.[1]' "$WORKDIR/network-overrides.json" "$WORKDIR/native-overrides.json" >"$WORKDIR/overrides.json"
    json_program 'template_values($c[0]) | .services += $c[0].runtimeServices | del(.services.issuerBootstrap) |
        .issuerBootstrapUrl=($c[0].runtimeServices.issuerBootstrap // .issuerBootstrapUrl) |
        .storageRegion=($c[0].storageRegion // "EU") | .storageCountry=($c[0].storageCountry // "DE")' \
        --slurpfile c "$CONFIG" "$DEPLOYMENT/templates/runtime-config.json" >"$WORKDIR/runtime-config.json"
    export ESB_NETWORK_VALUES="$WORKDIR/network-values.json" ESB_CORE_VALUES="$WORKDIR/core-values.json"
    export ESB_STORAGE_VALUES="$WORKDIR/core-values.json" ESB_OCM_VALUES="$WORKDIR/ocm-values.json"
    export ESB_OBSERVABILITY_VALUES="$WORKDIR/observability-values.json"
    export ESB_STORAGE_CLASS
    ESB_STORAGE_CLASS=$(config_value '.actualStorageClass')
    export ESB_NATIVE_DIDCOMM
    ESB_NATIVE_DIDCOMM=$(jq -r '.runtimeServices.didcomm == null' "$CONFIG")
    if [[ $(config_value '.externalDns') == true ]]; then
        jq '{apiVersion:"v1",kind:"Secret",metadata:{name:"external-dns",namespace:"infrastructure"},type:"Opaque",stringData:.dnsSecret}' \
            "$CONFIG" >"$WORKDIR/dns-secret.json"
        export ESB_DNS_SECRET_FILE="$WORKDIR/dns-secret.json"
    else
        export ESB_DNS_SECRET_FILE=''
    fi
}

add_chart_job() {
    local release=$1 chart=$2 namespace=$3 root=$4 values=$5 files=${6:-'[]'} parameters=${7:-'[]'} set=${8:-}
    jq --arg release "$release" --arg chart "$chart" --arg namespace "$namespace" --arg root "$root" \
        --arg set "$set" --slurpfile values "$values" --argjson files "$files" --argjson parameters "$parameters" \
        '. + [{release:$release,chart:$chart,namespace:$namespace,root:$root,values:$values[0],files:$files,parameters:$parameters,
               applicationSet:(if $set=="" then null else $set end)}]' "$WORKDIR/chart-jobs.json" >"$WORKDIR/chart-jobs-next.json"
    mv "$WORKDIR/chart-jobs-next.json" "$WORKDIR/chart-jobs.json"
}

chart_plan() {
    local name path namespace file parent chart release profile values
    printf '[]\n' >"$WORKDIR/chart-jobs.json"
    printf '{}\n' >"$WORKDIR/empty.json"
    while IFS=$'\t' read -r name path namespace; do
        values="$WORKDIR/empty.json"
        [[ $name != observability ]] || values="$WORKDIR/observability-values.json"
        add_chart_job "$name" "$path" "$namespace" "$SOURCE" "$values"
    done <<'CHARTS'
observability	INFRA/observability/opentelemtry	observability
openbao	INFRA/security/openbao	security
eso	INFRA/security/eso	security
kyverno	INFRA/security/kyverno	security
kubernetes-operator	INFRA/kubernetes-operator	security
CHARTS
    for name in infrastructure ocm-wstack; do
        file=$name
        [[ $name != infrastructure ]] || file=infra
        add_chart_job "$name-namespace" INFRA/app-management/app-namespace security "$SOURCE" "$WORKDIR/empty.json" \
            "$(jq -cn --arg file "INFRA/app-management/app-namespace-values/$file-values.yaml" '[$file]')"
    done
    while IFS=$'\t' read -r name file parent; do
        namespace=infrastructure
        [[ $name != ocm-wstack ]] || namespace=ocm-wstack
        jq -e --arg name "$name" --arg namespace "$namespace" --arg path "$parent/*" \
            '.[$name] | .name==$name and .namespace==$namespace and .path==$path and .matrix.enabled!=true' \
            "$WORKDIR/appsets.json" >/dev/null || { fail CHART_PLAN "Unsupported ApplicationSet definition: $name"; return 1; }
        cp "$ARGO_SOURCE/XFSC/Applicationsets/values/$file-values.yaml" "$SOURCE/XFSC/Applicationsets/values/$file-values.yaml"
        jq --arg name "$name" --slurpfile c "$CONFIG" '.[$name].excludes // [] |
            if $name=="ocm-wstack" and $c[0].runtimeServices.didcomm==null then map(select(.!="OCM W-Stack/Didcomm"))
            elif $name=="network" then .+["INFRA/network/cluster-issuer"]+(if $c[0].externalDns then [] else ["INFRA/network/external-dns"] end)
            else . end |
            reduce .[] as $item ([]; if index($item)==null then .+[$item] else . end)' \
            "$WORKDIR/appsets.json" >"$WORKDIR/excludes.json"
        if [[ $name == ocm-wstack ]]; then
            update_config '.ocmExcludes=$excludes[0]' --slurpfile excludes "$WORKDIR/excludes.json"
            write_values
        fi
        case "$name" in
            network) values=$WORKDIR/network-values.json ;;
            ocm-wstack) values=$WORKDIR/ocm-values.json ;;
            *) values=$WORKDIR/core-values.json ;;
        esac
        jq --slurpfile c "$CONFIG" '.+{storageClass:$c[0].actualStorageClass}' "$values" >"$WORKDIR/parent-values.json"
        if [[ $name == network ]]; then
            jq --slurpfile c "$CONFIG" '.+($c[0]|{profile,domain,email})' "$WORKDIR/parent-values.json" >"$WORKDIR/parent-values-next.json"
            mv "$WORKDIR/parent-values-next.json" "$WORKDIR/parent-values.json"
        fi
        add_chart_job "$name" XFSC/Applicationsets/chart "$namespace" "$SOURCE" "$WORKDIR/parent-values.json" \
            "$(jq -cn --arg file "XFSC/Applicationsets/values/$file-values.yaml" '[$file]')"
        local directory
        while IFS= read -r -d '' directory; do
            chart="$parent/${directory##*/}"
            jq -e --arg chart "$chart" 'index($chart)!=null' "$WORKDIR/excludes.json" >/dev/null && continue
            [[ -f $directory/Chart.yaml ]] || { fail CHART_PLAN "Selected directory has no Chart.yaml: $chart"; return 1; }
            release=$(printf '%s' "${directory##*/}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/-/g')
            local files='[]' parameters
            [[ ! -f $directory/values.yaml ]] || files=$(jq -cn --arg file "$chart/values.yaml" '[$file]')
            parameters=$(jq -cn --arg storage "$ESB_STORAGE_CLASS" '["global.storageClass="+$storage]')
            if [[ $name == network ]]; then
                profile=$(config_value '.profile')
                [[ ! -f $directory/profiles/$profile.yaml ]] || files=$(jq -c --arg file "$chart/profiles/$profile.yaml" '.+[$file]' <<<"$files")
                parameters=$(jq -c --slurpfile c "$CONFIG" '.+[$c[0] | "global.domain="+.domain,"external-dns.domainFilters[0]="+.domain,"global.profile="+.profile,"global.email="+.email,"acme.email="+.email]' <<<"$parameters")
            fi
            jq --arg chart "$chart" '.[$chart] // {}' "$WORKDIR/overrides.json" >"$WORKDIR/child-values.json"
            add_chart_job "$release" "$chart" "$namespace" "$ARGO_SOURCE" "$WORKDIR/child-values.json" "$files" "$parameters" "$name"
        done < <(find "$ARGO_SOURCE/$parent" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0 | sort -z)
    done <<'SETS'
storage	03_storage	INFRA/storage
network	04_network	INFRA/network
core	05_core	INFRA/core
ocm-wstack	06_ocm_wstack	OCM W-Stack
SETS
    jq '{externalTrafficPolicy,tenantHost,gatewayClusterIP:"192.0.2.1"}' "$CONFIG" >"$WORKDIR/gateway-values.json"
    add_chart_job esb-ocm-gateway charts-gateway security "$ROOT" "$WORKDIR/gateway-values.json"
    jq '{tlsSecret:("esb-"+.tenantRelease+"-tls"),services:(if .publicDashboards then
        [{name:"argocd",namespace:"argocd",host:("argocd."+.domain),service:"argocd-server",port:80},
         {name:"grafana",namespace:"observability",host:("grafana."+.domain),service:"observability-grafana",port:80}] else [] end)}' \
        "$CONFIG" >"$WORKDIR/dashboard-values.json"
    add_chart_job esb-dashboard-routes charts-dashboards infrastructure "$ROOT" "$WORKDIR/dashboard-values.json"
    jq --slurpfile runtime "$WORKDIR/runtime-config.json" '{host:.tenantHost,image:.runtimeImage,
        gatewayPorts:[80,443,10080,10443],hostAliases:[{ip:"192.0.2.1",hostnames:[.tenantHost]}],
        listenerSetName:(.tenantRelease+"-xfsc-tenant-gateway"),storage:{class:.actualStorageClass,orceSize:.orceStorageSize,mongoSize:.mongoStorageSize},
        mongo:{embedded:(.useExternalMongo|not),externalPorts:[27017]},runtimeConfig:$runtime[0]}' "$CONFIG" >"$WORKDIR/runtime-values.json"
    add_chart_job ocm-orce-ui charts-runtime ocm-wstack "$ROOT" "$WORKDIR/runtime-values.json"
    add_chart_job "$(config_value '.tenantRelease')" XFSC/tenant/chart ocm-wstack "$SOURCE" "$WORKDIR/tenant-values.json" '["XFSC/tenant/values/tenant-ocm-wstack-values.yaml"]'
}

prepare_charts() {
    phase chart-preflight
    run 300 git -C "$SOURCE" fetch --depth=1 origin "$(jq -r '.argoRevision' "$ROOT/upstream-lock.json")"
    local revision
    revision=$(git -C "$SOURCE" rev-parse FETCH_HEAD)
    [[ $revision == "$(jq -r '.commit' "$ROOT/upstream-lock.json")" ]] ||
        { fail UPSTREAM_COMMIT 'ApplicationSet source differs from the pinned bootstrap commit.'; return 1; }
    export ARGO_SOURCE="$WORKDIR/argo-source"
    run 30 git -C "$SOURCE" worktree add --detach "$ARGO_SOURCE" "$revision"
    jq -n --rawfile envoy "$ARGO_SOURCE/INFRA/network/envoy/values.yaml" \
        --rawfile retrieval "$ARGO_SOURCE/OCM W-Stack/Credential Retrieval/values.yaml" \
        --rawfile tenant "$SOURCE/XFSC/tenant/values/tenant-ocm-wstack-values.yaml" \
        --rawfile tenantChart "$SOURCE/XFSC/tenant/chart/values.yaml" \
        '{envoy:$envoy,retrieval:$retrieval,tenant:$tenant,tenantChart:$tenantChart}' >"$WORKDIR/default-documents.json"
    read_yaml "$WORKDIR/default-documents.json" "$WORKDIR/defaults.json"
    update_config '.upstreamAnnotationKeys=($defaults[0].envoy.envoyProxy.service.annotations // {} | keys) |
        .storageRegion=($defaults[0].retrieval["credential-retrieval-service"].config.region // "EU") |
        .storageCountry=($defaults[0].retrieval["credential-retrieval-service"].config.country // "DE")' --slurpfile defaults "$WORKDIR/defaults.json"
    validate_storage_scope
    json_program 'tenant_values($defaults[0].tenantChart * $defaults[0].tenant)' --slurpfile defaults "$WORKDIR/defaults.json" "$CONFIG" >"$WORKDIR/tenant-values.json"
    write_values
    jq -n --rawfile storage "$ARGO_SOURCE/XFSC/Applicationsets/values/03_storage-values.yaml" \
        --rawfile network "$ARGO_SOURCE/XFSC/Applicationsets/values/04_network-values.yaml" \
        --rawfile core "$ARGO_SOURCE/XFSC/Applicationsets/values/05_core-values.yaml" \
        --rawfile ocm "$ARGO_SOURCE/XFSC/Applicationsets/values/06_ocm_wstack-values.yaml" \
        '{storage:$storage,network:$network,core:$core,"ocm-wstack":$ocm}' >"$WORKDIR/appset-documents.json"
    read_yaml "$WORKDIR/appset-documents.json" "$WORKDIR/appsets.json"
    chart_plan
    if [[ $(config_value '.externalDns') == true ]]; then
        mkdir "$WORKDIR/frozen-charts"
        run 180 helm pull external-dns --repo https://kubernetes-sigs.github.io/external-dns/ \
            --version "$(jq -r '.helmPins["external-dns"]' "$ROOT/upstream-lock.json")" --untar --untardir "$WORKDIR/frozen-charts"
        json_program 'dns_values($lock[0])' --slurpfile lock "$ROOT/upstream-lock.json" "$CONFIG" >"$WORKDIR/external-dns-values.json"
        jq --arg root "$WORKDIR/frozen-charts" --slurpfile values "$WORKDIR/external-dns-values.json" \
            'map(if .chart=="INFRA/network/external-dns" then .+{root:$root,chart:"external-dns",files:[],parameters:[],values:$values[0]} else . end)' \
            "$WORKDIR/chart-jobs.json" >"$WORKDIR/chart-jobs-next.json"
        mv "$WORKDIR/chart-jobs-next.json" "$WORKDIR/chart-jobs.json"
    fi
    printf '{}\n' >"$WORKDIR/chart-documents.json"
    local location
    while IFS= read -r location; do
        jq --arg location "$location" --rawfile text "$location/Chart.yaml" '.+{($location):$text}' \
            "$WORKDIR/chart-documents.json" >"$WORKDIR/chart-documents-next.json"
        mv "$WORKDIR/chart-documents-next.json" "$WORKDIR/chart-documents.json"
    done < <(jq -r '.[] | .root+"/"+.chart' "$WORKDIR/chart-jobs.json" | sort -u)
    read_yaml "$WORKDIR/chart-documents.json" "$WORKDIR/charts.json"
    local repo number=0
    while IFS= read -r repo; do
        run 120 helm repo add "esb-audit-$number" "$repo"
        number=$((number+1))
    done < <(jq -r '[.[] | .dependencies[]?.repository | select(test("^https?://"))] | unique[]' "$WORKDIR/charts.json")
    kube_json "$WORKDIR/kube-version.json" version -o json
    local kube_version
    kube_version=$(jq -er '.serverVersion.gitVersion' "$WORKDIR/kube-version.json")
    [[ $kube_version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]] || fail CHART_PLAN 'Kubernetes server version is unavailable.'
    printf '[]\n' >"$WORKDIR/provider-documents.json"
    local index total chart release namespace root file parameter api digest
    local -A built=()
    printf '[]\n' >"$WORKDIR/chart-results.json"
    total=$(jq 'length' "$WORKDIR/chart-jobs.json")
    for ((index=0; index<total; index++)); do
        jq --argjson i "$index" '.[$i]' "$WORKDIR/chart-jobs.json" >"$WORKDIR/chart-job.json"
        chart=$(jq -r '.chart' "$WORKDIR/chart-job.json")
        release=$(jq -r '.release' "$WORKDIR/chart-job.json")
        namespace=$(jq -r '.namespace' "$WORKDIR/chart-job.json")
        root=$(jq -r '.root' "$WORKDIR/chart-job.json")
        location="$root/$chart"
        emit "$(jq -cn --arg chart "$chart" --arg release "$release" --argjson step "$((index+1))" --argjson total "$total" \
            '{type:"chart",chart:$chart,release:$release,step:$step,total:$total}')"
        if [[ -z ${built[$location]:-} ]]; then
            if jq -e --arg location "$location" '.[$location].dependencies|length>0' "$WORKDIR/charts.json" >/dev/null; then
                run 300 helm dependency build "$location"
            fi
            built[$location]=true
        fi
        jq '.values' "$WORKDIR/chart-job.json" >"$WORKDIR/chart-values.json"
        local args=(template "$release" "$location" --namespace "$namespace" --kube-version "$kube_version" --include-crds)
        for api in monitoring.coreos.com/v1 monitoring.coreos.com/v1/ServiceMonitor monitoring.coreos.com/v1/PrometheusRule \
            external-secrets.io/v1 argoproj.io/v1alpha1 gateway.networking.k8s.io/v1 gateway.networking.k8s.io/v1/Gateway cert-manager.io/v1 resources.xfsc.io/v1alpha1; do
            args+=(--api-versions "$api")
        done
        while IFS= read -r file; do args+=(-f "$root/$file"); done < <(jq -r '.files[]' "$WORKDIR/chart-job.json")
        args+=(-f "$WORKDIR/chart-values.json")
        while IFS= read -r parameter; do args+=(--set-string "$parameter"); done < <(jq -r '.parameters[]' "$WORKDIR/chart-job.json")
        args+=(--output-dir "$WORKDIR/render-$index")
        if ! run_capture "$WORKDIR/chart-output" 180 helm "${args[@]}"; then
            fail CHART_PREFLIGHT "Chart $chart failed before installation: $(safe_error "$LAST_ERROR")"
            return 1
        fi
        if grep -Eq 'cannot overwrite table with non table|destination for .* is a table' "$LAST_ERROR"; then
            fail CHART_PREFLIGHT "Chart $chart contains incompatible merged values."
            return 1
        fi
        validate_chart_manifests "$WORKDIR/render-$index" "$chart" "$release" "$namespace"
        digest=null
        [[ ! -f $location/Chart.lock ]] || digest=$(sha256sum "$location/Chart.lock" | cut -d ' ' -f 1)
        jq --slurpfile job "$WORKDIR/chart-job.json" --arg digest "$digest" \
            '.+[$job[0] | {chart,release,namespace,applicationSet,dependencyLockSha256:(if $digest=="null" then null else $digest end)}]' \
            "$WORKDIR/chart-results.json" >"$WORKDIR/chart-results-next.json"
        mv "$WORKDIR/chart-results-next.json" "$WORKDIR/chart-results.json"
    done
    local provider_errors
    provider_errors=$(jq -c -L "$DEPLOYMENT" 'include "filters"; provider_contract_errors' "$WORKDIR/provider-documents.json")
    [[ $provider_errors == '[]' ]] || { fail CHART_PROVIDERS "Unresolved chart providers: $provider_errors"; return 1; }
    policy_image_preflight
    export ESB_ARGO_MANIFEST="$WORKDIR/argo-install.yaml"
    run 130 curl --disable --fail --silent --show-error --location --max-time 120 \
        --output "$WORKDIR/argo-original.yaml" \
        "https://raw.githubusercontent.com/argoproj/argo-cd/$(jq -r '.argoCdCommit' "$ROOT/upstream-lock.json")/manifests/install.yaml"
    sed -E 's#(^[[:blank:]]*image:[[:blank:]]*)public\.ecr\.aws/docker/library/redis(:[a-zA-Z0-9_.-]+)([[:blank:]]*$)#\1docker.io/library/redis\2\3#' \
        "$WORKDIR/argo-original.yaml" >"$ESB_ARGO_MANIFEST"
    grep -q 'kind: CustomResourceDefinition' "$ESB_ARGO_MANIFEST" && grep -q 'name: argocd-server' "$ESB_ARGO_MANIFEST" ||
        { fail ARGO_MANIFEST 'Argo manifest lacks the expected resources.'; return 1; }
    export ESB_APPSET_COUNTS
    ESB_APPSET_COUNTS=$(jq -c 'group_by(.applicationSet) | map(select(.[0].applicationSet!=null) | {key:.[0].applicationSet,value:length}) | from_entries' "$WORKDIR/chart-jobs.json")
    jq -n --arg revision "$revision" --arg kubeVersion "$kube_version" --slurpfile charts "$WORKDIR/chart-results.json" \
        --argjson counts "$ESB_APPSET_COUNTS" --arg hash "$(sha256sum "$ESB_ARGO_MANIFEST" | cut -d ' ' -f 1)" \
        '{status:"charts-validated",argoTrackingRevision:$revision,argoRevision:$revision,kubeVersion:$kubeVersion,
          charts:$charts[0],applicationCounts:$counts,argoRedisRegistry:"docker.io/library/redis",argoManifestSha256:$hash}' >"$WORKDIR/chart-report.json"
    emit "$(jq -cn --arg revision "$revision" --argjson count "$total" '{type:"chart-preflight-complete",argoRevision:$revision,chartCount:$count}')"
}

rendered_documents() {
    local directory=$1 output=$2 file
    printf '{}\n' >"$WORKDIR/rendered-yaml.json"
    while IFS= read -r -d '' file; do
        jq --arg file "$file" --rawfile content "$file" \
            '. + ($content | split("\n---") | to_entries | map({key:($file+"/"+(.key|tostring)),value:.value}) | from_entries)' \
            "$WORKDIR/rendered-yaml.json" >"$WORKDIR/rendered-yaml-next.json"
        mv "$WORKDIR/rendered-yaml-next.json" "$WORKDIR/rendered-yaml.json"
    done < <(find "$directory" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)
    read_yaml "$WORKDIR/rendered-yaml.json" "$output"
}

validate_chart_manifests() {
    local directory=$1 chart=$2 release=$3 namespace=${4:-default}
    rendered_documents "$directory" "$WORKDIR/manifests.json"
    if [[ -f $WORKDIR/provider-documents.json ]]; then
        jq -s --arg namespace "$namespace" '.[0]+[.[1][] | select(.kind=="ResourceProvider" or .kind=="ResourceClaim" or .kind=="ExternalSecret" or .kind=="Deployment" or .kind=="StatefulSet" or .kind=="DaemonSet") | .metadata.namespace //= $namespace]' \
            "$WORKDIR/provider-documents.json" "$WORKDIR/manifests.json" >"$WORKDIR/provider-documents-next.json"
        mv "$WORKDIR/provider-documents-next.json" "$WORKDIR/provider-documents.json"
    fi
    case "$chart" in
        'OCM W-Stack/Policy Chart'|'OCM W-Stack/Credential Verification Service Chart'|'OCM W-Stack/Didcomm'|'OCM W-Stack/Pre Authorization Bridge Chart'|'OCM W-Stack/Well Known Chart'|'INFRA/core/nats'|'INFRA/core/universal-resolver'|'INFRA/observability/opentelemtry') ;;
        *) return 0 ;;
    esac
    if [[ $chart == 'OCM W-Stack/Credential Verification Service Chart' || $chart == 'OCM W-Stack/Policy Chart' ]]; then
        local failed_checks
        failed_checks=$(jq -r -L "$DEPLOYMENT" --arg chart "$chart" 'include "filters"; (if $chart=="OCM W-Stack/Policy Chart" then policy_chart_checks else verification_chart_checks end) |
            to_entries | map(select(.value!=true)|.key) | join(", ")' "$WORKDIR/manifests.json")
        [[ -z $failed_checks ]] || { fail CHART_CONTRACT "$chart checks failed: $failed_checks."; return 1; }
    else
        jq -L "$DEPLOYMENT" -e --arg chart "$chart" 'include "filters"; validate_chart($chart)' \
            "$WORKDIR/manifests.json" >/dev/null || { fail CHART_CONTRACT "Rendered contract changed for $chart."; return 1; }
    fi
    if [[ $release == observability ]]; then
        jq '[.[] | select((.kind=="ConfigMap" or .kind=="Secret") and .metadata.labels.grafana_datasource=="1") |
            . as $doc | ((.data // {} | to_entries[] | .value |= (if $doc.kind=="Secret" then @base64d else . end)),
                        (.stringData // {} | to_entries[])) | select(.key|test("\\.ya?ml$")) |
            {key:($doc.metadata.name+"/"+.key),value:.value}] | from_entries' "$WORKDIR/manifests.json" >"$WORKDIR/datasource-yaml.json"
        read_yaml "$WORKDIR/datasource-yaml.json" "$WORKDIR/datasources.json"
        jq -L "$DEPLOYMENT" -e 'include "filters"; validate_datasources' "$WORKDIR/datasources.json" >/dev/null ||
            fail GRAFANA_DATASOURCES 'Grafana datasource names, UIDs or defaults are inconsistent.'
    fi
}
