#!/usr/bin/env bash
# Continuous reconciliation of native consumer credentials and NATS listeners.
# Mounted read-only in the ESB-owned reconciler Pod; private working files use
# the memory-backed /state volume. Public status never includes secret values.
set -Eeuo pipefail
shopt -s inherit_errexit
umask 077

GUARD_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STATE_DIR=${OCM_GUARD_STATE_DIR:-/state/guard}
API_ACCOUNT=/var/run/secrets/kubernetes.io/serviceaccount
REDIS_FD=
HTTP_PID=
ITERATION_PID=

guard_error() {
    jq -cn --arg code "$1" --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        '{ready:false,code:$code,checkedAt:$now}' >"$STATE_DIR/failure.json"
    return 1
}

guard_filter() {
    local expression=$1
    shift
    jq -L "$GUARD_ROOT" "include \"filters\"; $expression" "$@"
}

api_path() {
    local kind=$1 namespace=${2:-} name=${3:-} prefix
    case "$kind" in
        deployments|replicasets) prefix=apis/apps/v1 ;;
        resourceclaims|resourceproviders) prefix=apis/resources.xfsc.io/v1alpha1 ;;
        externalsecrets) prefix=apis/external-secrets.io/v1 ;;
        secrets|pods|endpoints) prefix=api/v1 ;;
        *) guard_error GUARD_API_KIND; return 1 ;;
    esac
    printf '/%s' "$prefix"
    [[ -z $namespace ]] || printf '/namespaces/%s' "$namespace"
    printf '/%s' "$kind"
    [[ -z $name ]] || printf '/%s' "$name"
}

api_request() {
    local method=$1 endpoint=$2 output=$3 body=${4:-} host port
    host=${KUBERNETES_SERVICE_HOST:?}
    port=${KUBERNETES_SERVICE_PORT_HTTPS:-443}
    [[ $host != *:* ]] || host="[$host]"
    local args=(--disable --fail --silent --show-error --connect-timeout 5 --max-time 10 --max-filesize 16777216
        --cacert "$API_ACCOUNT/ca.crt" --request "$method" --header "@$STATE_DIR/api-authorization")
    {
        printf 'Authorization: Bearer '
        tr -d '\r\n' <"$API_ACCOUNT/token"
        printf '\n'
    } >"$STATE_DIR/api-authorization"
    if [[ -n $body ]]; then
        args+=(--header 'Content-Type: application/json-patch+json' --data-binary "@$body")
    fi
    if ! curl "${args[@]}" "https://$host:$port$endpoint" >"$output" 2>"$STATE_DIR/curl-error"; then
        guard_error GUARD_TRANSPORT
        return 1
    fi
    jq -e 'type=="object"' "$output" >/dev/null || guard_error GUARD_JSON
}

api_list() {
    local kind=$1 output=$2 cursor='' endpoint
    endpoint=$(api_path "$kind" ocm-wstack)
    printf '[]\n' >"$output"
    while :; do
        api_request GET "$endpoint?limit=500${cursor:+&continue=$cursor}" "$STATE_DIR/page.json"
        jq -e '.items|type=="array"' "$STATE_DIR/page.json" >/dev/null || guard_error KUBE_LIST_CONTRACT
        jq --slurpfile page "$STATE_DIR/page.json" '.+$page[0].items' "$output" >"$STATE_DIR/list-next.json"
        mv "$STATE_DIR/list-next.json" "$output"
        cursor=$(jq -r '.metadata.continue // "" | @uri' "$STATE_DIR/page.json")
        [[ -n $cursor ]] || break
    done
}

annotate_deployment() {
    local deployment=$1 annotations=$2 name
    name=$(jq -r '.metadata.name' "$deployment")
    jq --slurpfile annotations "$annotations" \
        '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
          {op:"add",path:"/spec/template/metadata/annotations",value:((.spec.template.metadata.annotations // {})+$annotations[0])}]' \
        "$deployment" >"$STATE_DIR/deployment-patch.json"
    api_request PATCH "$(api_path deployments ocm-wstack "$name")" "$STATE_DIR/patched.json" "$STATE_DIR/deployment-patch.json"
}

credential_digest() {
    local deployment=$1 secrets=$2 output=$3
    guard_filter 'credential_references($secrets[0])' --slurpfile secrets "$secrets" "$deployment" >"$STATE_DIR/references.json"
    if jq -e 'length==0' "$STATE_DIR/references.json" >/dev/null; then
        printf 'null\n' >"$output"
    else
        jq -cj '.' "$STATE_DIR/references.json" | sha256sum | cut -d ' ' -f 1 | jq -R . >"$output"
    fi
}

# RESP2 is framed by byte counts, not whitespace. Each command uses a private
# JSON array; jq writes the exact UTF-8 byte lengths and payloads to the socket.
resp_write() {
    jq -jr '"*"+(length|tostring)+"\r\n", (.[] | tostring | "$"+(utf8bytelength|tostring)+"\r\n"+.+"\r\n")' "$1" >&"$REDIS_FD"
}

resp_read() {
    local depth=${1:-0} line length data ending index array='[]'
    ((depth < 32)) || { guard_error REDIS_PROTOCOL; return 1; }
    IFS= read -r -t 10 line <&"$REDIS_FD" || { guard_error REDIS_CONNECTION; return 1; }
    [[ $line == *$'\r' && ${#line} -le 1048576 ]] || { guard_error REDIS_PROTOCOL; return 1; }
    line=${line%$'\r'}
    case "${line:0:1}" in
        +) RESP_JSON=$(jq -cn --arg value "${line:1}" '$value'); return ;;
        -) guard_error REDIS_COMMAND; return 1 ;;
        :) [[ ${line:1} =~ ^-?[0-9]+$ ]] || { guard_error REDIS_PROTOCOL; return 1; }
           RESP_JSON=$(jq -cn --arg value "${line:1}" '$value|tonumber'); return ;;
        '$'|'*') ;;
        *) guard_error REDIS_PROTOCOL; return 1 ;;
    esac
    [[ ${line:1} =~ ^(-1|[0-9]+)$ ]] || { guard_error REDIS_PROTOCOL; return 1; }
    length=${line:1}
    ((length >= -1 && length <= 1048576)) || { guard_error REDIS_PROTOCOL; return 1; }
    if ((length == -1)); then RESP_JSON=null; return; fi
    if [[ ${line:0:1} == '$' ]]; then
        data=''
        if ((length > 0)); then
            IFS= LC_ALL=C read -r -N "$length" -t 10 data <&"$REDIS_FD" || { guard_error REDIS_CONNECTION; return 1; }
        fi
        IFS= read -r -N 2 -t 10 ending <&"$REDIS_FD" || { guard_error REDIS_PROTOCOL; return 1; }
        [[ $ending == $'\r\n' ]] || { guard_error REDIS_PROTOCOL; return 1; }
        RESP_JSON=$(jq -cn --arg value "$data" '$value')
    else
        for ((index=0; index<length; index++)); do
            resp_read "$((depth+1))"
            array=$(jq -c --argjson value "$RESP_JSON" '.+[$value]' <<<"$array")
        done
        RESP_JSON=$array
    fi
}

redis_command() {
    resp_write "$1"
    resp_read
    printf '%s\n' "$RESP_JSON" >"$2"
}

redis_connect() {
    local host=$1 port=$2
    exec {REDIS_FD}<>"/dev/tcp/$host/$port" || { guard_error REDIS_CONNECTION; return 1; }
}

redis_close() {
    [[ -z $REDIS_FD ]] || exec {REDIS_FD}>&-
    REDIS_FD=
}

ensure_redis() {
    local contract=$1 host port hash changed=false
    host=$(jq -r '.endpoint.host' "$contract")
    port=$(jq -r '.endpoint.port' "$contract")
    hash=$(jq -jr '.password' "$contract" | sha256sum | cut -d ' ' -f 1)
    redis_connect "$host" "$port"
    jq '["AUTH"] + (if .admin.username then [.admin.username] else [] end) + [.admin.password]' "$contract" >"$STATE_DIR/redis-command.json"
    redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
    jq '["ACL","GETUSER",.username]' "$contract" >"$STATE_DIR/redis-command.json"
    redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
    if ! jq -e --arg hash "$hash" '
        if .==null then false else
            . as $list | [range(0;length;2) | {key:$list[.],value:$list[.+1]}] | from_entries |
            (.flags|index("on")!=null and index("nopass")==null) and .passwords==[$hash] and
            .keys=="~auth:*" and .commands=="+@all" and (.selectors // []|length)==0 end
    ' "$STATE_DIR/redis-response.json" >/dev/null; then
        jq --arg hash "$hash" '["ACL","SETUSER",.username,"reset","on","#"+$hash,"~auth:*","+@all"]' "$contract" >"$STATE_DIR/redis-command.json"
        redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
        changed=true
    fi
    redis_close
    redis_connect "$host" "$port"
    jq '["AUTH",.username,.password]' "$contract" >"$STATE_DIR/redis-command.json"
    redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
    printf '["PING"]\n' >"$STATE_DIR/redis-command.json"
    redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
    jq -e '.=="PONG"' "$STATE_DIR/redis-response.json" >/dev/null || guard_error REDIS_AUTHENTICATION
    if jq -e '.database!=0' "$contract" >/dev/null; then
        jq '["SELECT",(.database|tostring)]' "$contract" >"$STATE_DIR/redis-command.json"
        redis_command "$STATE_DIR/redis-command.json" "$STATE_DIR/redis-response.json"
    fi
    redis_close
    jq -cn --argjson changed "$changed" '{authenticated:true,changed:$changed}' >"$STATE_DIR/redis-status.json"
}

nats_connections() {
    api_request GET "$(api_path endpoints infrastructure nats)" "$STATE_DIR/nats-endpoints.json"
    jq -e '[.subsets[]?.addresses[]?.ip]|length>0' "$STATE_DIR/nats-endpoints.json" >/dev/null || guard_error NATS_ENDPOINTS_PENDING
    local ip host
    printf '[]\n' >"$STATE_DIR/connections.json"
    while IFS= read -r ip; do
        [[ $ip =~ ^[0-9a-fA-F:.]+$ ]] || { guard_error NATS_ENDPOINT_CONTRACT; return 1; }
        host=$ip
        [[ $host != *:* ]] || host="[$host]"
        curl --disable --fail --silent --show-error --connect-timeout 5 --max-time 10 --max-filesize 16777216 \
            "http://$host:8222/connz?subs=1&limit=100000" >"$STATE_DIR/connz.json" 2>"$STATE_DIR/curl-error" || guard_error GUARD_TRANSPORT
        jq -e '(.connections|type)=="array" and .total==(.connections|length)' "$STATE_DIR/connz.json" >/dev/null || guard_error NATS_MONITOR_INCOMPLETE
        jq --slurpfile page "$STATE_DIR/connz.json" '.+$page[0].connections' "$STATE_DIR/connections.json" >"$STATE_DIR/connections-next.json"
        mv "$STATE_DIR/connections-next.json" "$STATE_DIR/connections.json"
    done < <(jq -r '[.subsets[]?.addresses[]?.ip]|unique[]' "$STATE_DIR/nats-endpoints.json")
}

uri_component() {
    local input=$1 escaped
    [[ ! $input =~ %([^[:xdigit:]]|[[:xdigit:]]$|$) && ! $input =~ %[[:xdigit:]][^[:xdigit:]] && ! $input =~ %00 ]] ||
        { guard_error NATS_ENDPOINT_CONTRACT; return 1; }
    escaped=$(printf '%s' "$input" | sed 's/\\/\\\\/g; s/%/\\x/g')
    printf '%b' "$escaped"
}

nats_connect() {
    exec {NATS_FD}<>/dev/tcp/nats.infrastructure.svc.cluster.local/4222 || { guard_error NATS_UNAVAILABLE; return 1; }
}

nats_ping() {
    local config=$1 NATS_FD line connected=false username password
    jq -e '.url|test("^nats://([^/@[:space:]]+@)?nats\\.infrastructure\\.svc\\.cluster\\.local:4222/?$")' "$config" >/dev/null || guard_error NATS_ENDPOINT_CONTRACT
    jq '.url | capture("^nats://(?:(?<user>[^:@/]+)(?::(?<password>[^@/]*))?@)?nats\\.infrastructure\\.svc\\.cluster\\.local:4222/?$")' "$config" >"$STATE_DIR/nats-authority.json"
    uri_component "$(jq -r '.user // ""' "$STATE_DIR/nats-authority.json")" >"$STATE_DIR/nats-user"
    uri_component "$(jq -r '.password // ""' "$STATE_DIR/nats-authority.json")" >"$STATE_DIR/nats-password"
    nats_connect
    while IFS= read -r -t 10 line <&"$NATS_FD"; do
        [[ ${#line} -le 65536 ]] || { guard_error NATS_UNAVAILABLE; return 1; }
        line=${line%$'\r'}
        case "$line" in
            'INFO '*)
                [[ $connected == false ]] || continue
                jq -e '.tls_required!=true' <<<"${line:5}" >/dev/null || guard_error NATS_UNAVAILABLE
                printf 'CONNECT ' >&"$NATS_FD"
                jq -cj --rawfile user "$STATE_DIR/nats-user" --rawfile password "$STATE_DIR/nats-password" \
                    '{verbose:false,pedantic:false} + (if $user!="" and $password!="" then {user:$user,pass:$password}
                     elif $user!="" then {auth_token:$user} else {} end)' <"$config" >&"$NATS_FD"
                printf '\r\nPING\r\n' >&"$NATS_FD"
                connected=true ;;
            PING) printf 'PONG\r\n' >&"$NATS_FD" ;;
            PONG) [[ $connected == true ]] || continue
                  exec {NATS_FD}>&-
                  return 0 ;;
            -ERR*) guard_error NATS_UNAVAILABLE; return 1 ;;
        esac
    done
    guard_error NATS_UNAVAILABLE
}

reconcile_once() {
    local kind name changed=false stable=true hash current previous now pending
    for kind in deployments secrets resourceclaims pods replicasets externalsecrets; do
        api_list "$kind" "$STATE_DIR/$kind.json"
    done
    jq -e 'any(.[];.metadata.name=="pre-authorization-bridge") and any(.[];.metadata.name=="well-known-service")' \
        "$STATE_DIR/deployments.json" >/dev/null || guard_error OCM_WORKLOADS_PENDING
    api_request GET "$(api_path resourceproviders '' redis)" "$STATE_DIR/provider.json"
    jq -e '.spec.adminSecretRef.namespace=="infrastructure" and .spec.adminSecretRef.name=="redis-root-auth"' \
        "$STATE_DIR/provider.json" >/dev/null || guard_error REDIS_ADMIN_CONTRACT
    api_request GET "$(api_path secrets infrastructure redis-root-auth)" "$STATE_DIR/admin-secret.json"
    guard_filter '.[] | select(.metadata.name=="pre-authorization-bridge") |
        redis_contract($claims[0];$provider[0];$secrets[0];$admin[0];$external[0])' \
        --slurpfile claims "$STATE_DIR/resourceclaims.json" --slurpfile provider "$STATE_DIR/provider.json" \
        --slurpfile secrets "$STATE_DIR/secrets.json" --slurpfile admin "$STATE_DIR/admin-secret.json" \
        --slurpfile external "$STATE_DIR/externalsecrets.json" "$STATE_DIR/deployments.json" >"$STATE_DIR/redis-contract.json"
    timeout -s TERM -k 2 30 bash "$GUARD_ROOT/reconcile.sh" --redis "$STATE_DIR/redis-contract.json"
    while IFS= read -r name; do
        jq --arg name "$name" '.[] | select(.metadata.name==$name)' "$STATE_DIR/deployments.json" >"$STATE_DIR/deployment.json"
        if [[ $name == credential-retrieval-service ]] &&
            guard_filter '(ready_workload|not) and .spec.template.metadata.annotations["esb.xfsc.io/credentials"]==null' -e "$STATE_DIR/deployment.json" >/dev/null; then
            continue
        fi
        credential_digest "$STATE_DIR/deployment.json" "$STATE_DIR/secrets.json" "$STATE_DIR/digest.json"
        hash=$(jq -r '.' "$STATE_DIR/digest.json")
        current=$(jq -r '.spec.template.metadata.annotations["esb.xfsc.io/credentials"] // ""' "$STATE_DIR/deployment.json")
        if [[ $hash != null && $hash != "$current" ]]; then
            jq '{"esb.xfsc.io/credentials":.}' "$STATE_DIR/digest.json" >"$STATE_DIR/annotations.json"
            annotate_deployment "$STATE_DIR/deployment.json" "$STATE_DIR/annotations.json"
            changed=true
        fi
    done < <(jq -r '.[] | select(.metadata.name!="esb-ocm-guard") | .metadata.name' "$STATE_DIR/deployments.json")
    nats_connections
    guard_filter '[.[] | select(.metadata.name=="pre-authorization-bridge" or .metadata.name=="well-known-service") |
        service_listeners($pods[0];$replicasets[0];$connections[0])]' \
        --slurpfile pods "$STATE_DIR/pods.json" --slurpfile replicasets "$STATE_DIR/replicasets.json" \
        --slurpfile connections "$STATE_DIR/connections.json" "$STATE_DIR/deployments.json" >"$STATE_DIR/listeners.json"
    jq '.[]|select(.metadata.name=="well-known-service")' "$STATE_DIR/deployments.json" >"$STATE_DIR/wellknown.json"
    if [[ $changed == false ]] && jq -e 'any(.[];.name=="well-known-service" and (.ready|not))' "$STATE_DIR/listeners.json" >/dev/null &&
        guard_filter 'ready_workload' -e "$STATE_DIR/wellknown.json" >/dev/null; then
        previous=$(jq -r 'try (.spec.template.metadata.annotations["esb.xfsc.io/nats-recovery"]|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601) catch 0' "$STATE_DIR/wellknown.json")
        now=$(date +%s)
        if ((now-previous >= 120)); then
            guard_filter 'environment("well-known-service") as $env |
                {url:env_value($env;"WELLKNOWN_SERVICE_NATS_URL";$secrets[0])}' \
                --slurpfile secrets "$STATE_DIR/secrets.json" "$STATE_DIR/wellknown.json" >"$STATE_DIR/nats-config.json"
            timeout -s TERM -k 2 15 bash "$GUARD_ROOT/reconcile.sh" --nats "$STATE_DIR/nats-config.json"
            jq -cn --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '{"esb.xfsc.io/nats-recovery":$now}' >"$STATE_DIR/annotations.json"
            annotate_deployment "$STATE_DIR/wellknown.json" "$STATE_DIR/annotations.json"
            changed=true
        fi
    fi
    api_list secrets "$STATE_DIR/latest-secrets.json"
    while IFS= read -r name; do
        jq --arg name "$name" '.[]|select(.metadata.name==$name)' "$STATE_DIR/deployments.json" >"$STATE_DIR/deployment.json"
        credential_digest "$STATE_DIR/deployment.json" "$STATE_DIR/secrets.json" "$STATE_DIR/digest-before.json"
        credential_digest "$STATE_DIR/deployment.json" "$STATE_DIR/latest-secrets.json" "$STATE_DIR/digest-after.json"
        cmp -s "$STATE_DIR/digest-before.json" "$STATE_DIR/digest-after.json" || stable=false
    done < <(jq -r '.[]|select(.metadata.name!="esb-ocm-guard")|.metadata.name' "$STATE_DIR/deployments.json")
    pending=$(guard_filter '[.[]|select(.metadata.name!="esb-ocm-guard" and (ready_workload|not))]|length' "$STATE_DIR/deployments.json")
    guard_filter '[.[]|select(.metadata.name=="credential-verification-service")][0] |
        verification_nats_ready($pods[0];$replicasets[0])' --slurpfile pods "$STATE_DIR/pods.json" \
        --slurpfile replicasets "$STATE_DIR/replicasets.json" "$STATE_DIR/deployments.json" >"$STATE_DIR/verification.json"
    jq -n --argjson changed "$changed" --argjson stable "$stable" --argjson pending "$pending" \
        --slurpfile redis "$STATE_DIR/redis-status.json" --slurpfile services "$STATE_DIR/listeners.json" \
        --slurpfile verification "$STATE_DIR/verification.json" --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '
        {ready:(($changed|not) and $stable and $pending==0 and $redis[0].authenticated and all($services[0][];.ready) and $verification[0]),
         verificationNats:{ready:$verification[0]},credentials:{synchronized:(($changed|not) and $stable and $pending==0),pendingRollouts:$pending},
         redis:{authenticated:$redis[0].authenticated},services:$services[0],checkedAt:$now} +
         (if $verification[0] then {} else {code:"VERIFICATION_NATS_CONTRACT"} end)' >"$STATE_DIR/result.json"
}

http_response() {
    local method url protocol header body status=200 reason=OK count=0
    IFS=' ' read -r -t 2 method url protocol || return 1
    while IFS= read -r -t 2 header; do
        [[ $header != $'\r' && -n $header ]] || break
        count=$((count+1))
        ((count <= 64 && ${#header} <= 8192)) || return 1
    done
    if [[ $method != GET ]]; then
        status=405; reason='Method Not Allowed'; body='{"error":"METHOD_NOT_ALLOWED"}'
    else
        case "$url" in
            /health) body='{"active":true}' ;;
            /status|/ready)
                body=$(cat "$STATE_DIR/status.json")
                if [[ $url == /ready ]] && ! jq -e '.ready==true' <<<"$body" >/dev/null; then status=503; reason='Service Unavailable'; fi ;;
            *) status=404; reason='Not Found'; body='{"error":"NOT_FOUND"}' ;;
        esac
    fi
    local length
    length=$(printf '%s' "$body" | wc -c)
    printf 'HTTP/1.1 %s %s\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: %s\r\n\r\n%s' "$status" "$reason" "$length" "$body"
}

guard_state_init() {
    # The mounted volume belongs to kubelet; the process owns this subdirectory.
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    jq -cn '{ready:false,code:"GUARD_STARTING"}' >"$STATE_DIR/status.json"
}

guard_main() {
    local tool
    for tool in bash jq curl openssl nc timeout sha256sum; do
        command -v "$tool" >/dev/null || { printf 'Missing reconciler command: %s\n' "$tool" >&2; return 1; }
    done
    guard_state_init
    (
        server_pid=''
        trap '[[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null; exit 0' TERM INT
        while :; do
            nc -l -p 8080 -e timeout 5 bash "$GUARD_ROOT/reconcile.sh" --http &
            server_pid=$!
            wait "$server_pid" || true
        done
    ) &
    HTTP_PID=$!
    trap guard_stop TERM INT
    while :; do
        rm -f "$STATE_DIR/failure.json"
        timeout -s TERM -k 2 120 bash "$GUARD_ROOT/reconcile.sh" --once 2>"$STATE_DIR/iteration-error" &
        ITERATION_PID=$!
        if wait "$ITERATION_PID"; then
            mv "$STATE_DIR/result.json" "$STATE_DIR/status-next.json"
        elif [[ -s $STATE_DIR/failure.json ]]; then
            cp "$STATE_DIR/failure.json" "$STATE_DIR/status-next.json"
        else
            jq -cn --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '{ready:false,code:"GUARD_RECONCILE",checkedAt:$now}' >"$STATE_DIR/status-next.json"
        fi
        ITERATION_PID=''
        mv "$STATE_DIR/status-next.json" "$STATE_DIR/status.json"
        jq -c '.' "$STATE_DIR/status.json"
        sleep 5
    done
}

guard_stop() {
    trap - TERM INT
    [[ -z $ITERATION_PID ]] || kill -TERM "$ITERATION_PID" 2>/dev/null || true
    [[ -z $HTTP_PID ]] || kill -TERM "$HTTP_PID" 2>/dev/null || true
    [[ -z $ITERATION_PID ]] || wait "$ITERATION_PID" 2>/dev/null || true
    [[ -z $HTTP_PID ]] || wait "$HTTP_PID" 2>/dev/null || true
    exit 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    case "${1:-}" in
        --once) reconcile_once ;;
        --redis) ensure_redis "$2" ;;
        --nats) nats_ping "$2" ;;
        --http) http_response ;;
        '') guard_main ;;
        *) exit 2 ;;
    esac
fi
