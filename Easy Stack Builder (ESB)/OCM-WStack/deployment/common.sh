#!/usr/bin/env bash
# Shared process, JSON and file handling for the deployment procedure.

umask 077
CURRENT_PID=
LEASE_PID=
TUNNEL_PIDS=()
OWNS_WORKDIR=false
RESULT_WRITTEN=false

timestamp() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

emit() {
    # FD 3 carries progress independently of a function's captured stdout.
    jq -cn --arg timestamp "$(timestamp)" --argjson event "$1" \
        '$event + {timestamp:$timestamp}' >&3
}

phase() {
    if [[ -n ${ESB_LOG_DIR:-} ]]; then printf '%s\n' "$1" >"$ESB_LOG_DIR/phase"; fi
    emit "$(jq -cn --arg phase "$1" '{type:"phase",phase:$phase}')"
}

fail() {
    local code=$1 message=$2
    jq -cn --arg code "$code" --arg message "$message" \
        '{status:"failed",code:$code,message:$message}' >"$WORKDIR/error.json"
    return 1
}

config_value() {
    jq -r "$1" "$CONFIG"
}

optional_value() {
    jq -r "$1 // empty" "$CONFIG"
}

update_config() {
    local filter=$1
    shift
    jq "$@" "$filter" "$CONFIG" >"$WORKDIR/config.next.json"
    mv "$WORKDIR/config.next.json" "$CONFIG"
}

json_program() {
    local expression=$1
    shift
    jq -L "$JSON_LIB_DIR" "include \"filters\"; $expression" "$@"
}

safe_error() {
    local file=$1
    # API errors can echo Secret objects. Only report a classified diagnostic.
    if grep -Eiq 'unauthorized|authentication required' "$file"; then printf 'authentication failed';
    elif grep -iq forbidden "$file"; then printf 'access was denied';
    elif grep -Eiq 'x509:|certificate verify' "$file"; then printf 'certificate verification failed';
    elif grep -Eiq 'pending-|another operation' "$file"; then printf 'another Helm operation is pending';
    elif grep -Eiq 'timed out|timeout|context deadline' "$file"; then printf 'request timed out';
    elif grep -Eiq 'Conflict|object has been modified|test failed' "$file"; then printf 'the resource changed during the operation';
    elif grep -Eiq 'not found|NotFound' "$file"; then printf 'the requested resource was not found';
    elif grep -Eiq 'EOF|connection reset|connection refused|broken pipe' "$file"; then printf 'connection interrupted';
    elif grep -Eiq 'no such host|could not resolve|EAI_AGAIN' "$file"; then printf 'DNS lookup failed';
    else printf 'command returned an error'; fi
}

# Commands keep their own files so concurrent hooks and lease renewal cannot
# overwrite one another. These raw files are outside the disposable WORKDIR.
command_log_start() {
    COMMAND_LOG=
    [[ -n ${ESB_LOG_DIR:-} ]] || return 0
    local seconds=$1
    shift
    COMMAND_LOG=$(mktemp -d "$ESB_LOG_DIR/command.XXXXXX")
    printf '%q ' "$@" >"$COMMAND_LOG/command.txt"
    printf '\n' >>"$COMMAND_LOG/command.txt"
    local current_phase='' tool=${1##*/}
    [[ ! -f $ESB_LOG_DIR/phase ]] || IFS= read -r current_phase <"$ESB_LOG_DIR/phase" || true
    jq -cn --arg id "${COMMAND_LOG##*/}" --arg command "$tool" \
        --arg phase "$current_phase" --arg startedAt "$(timestamp)" \
        --arg startedEpoch "${EPOCHREALTIME:-}" \
        --arg cwd "$PWD" --argjson timeoutSeconds "$seconds" \
        '{id:$id,command:$command,phase:$phase,startedAt:$startedAt,startedEpoch:$startedEpoch,cwd:$cwd,timeoutSeconds:$timeoutSeconds}' \
        >"$COMMAND_LOG/start.json"
    emit "$(jq -c '. + {type:"command-start",message:("Running "+.command)} | del(.cwd)' "$COMMAND_LOG/start.json")"
}

log_shell_error() {
    local status=$1 line=$2 source=$3 command=$4
    [[ -n ${ESB_LOG_DIR:-} ]] || return 0
    local file
    file=$(mktemp "$ESB_LOG_DIR/shell-error.XXXXXX") || return 0
    jq -cn --arg timestamp "$(timestamp)" --arg source "$source" \
        --arg command "$command" --argjson line "$line" --argjson exitCode "$status" \
        '{timestamp:$timestamp,source:$source,line:$line,command:$command,exitCode:$exitCode}' >"$file" || true
    emit "$(jq -cn --arg source "${source##*/}" --argjson line "$line" --argjson exitCode "$status" \
        '{type:"shell-error",source:$source,line:$line,exitCode:$exitCode,message:("Command failed in "+$source+":"+($line|tostring))}')" || true
    return 0
}

run_capture() {
    local output=$1 seconds=$2
    shift 2
    local error_file status=0 started=$SECONDS
    error_file=$(mktemp "$WORKDIR/command-error.XXXXXX")
    command_log_start "$seconds" "$@"
    local log=$COMMAND_LOG stdout_file=$output stderr_file=$error_file
    if [[ -n $log ]]; then stdout_file=$log/stdout; stderr_file=$log/stderr; fi
    timeout -s TERM -k 3 "$seconds" "$@" <&0 >"$stdout_file" 2>"$stderr_file" &
    CURRENT_PID=$!
    wait "$CURRENT_PID" || status=$?
    CURRENT_PID=
    if [[ -n $log ]]; then
        cp -- "$stdout_file" "$output"
        cp -- "$stderr_file" "$error_file"
        jq -cn --arg finishedAt "$(timestamp)" --argjson exitCode "$status" \
            --argjson elapsedSeconds "$((SECONDS-started))" \
            '{finishedAt:$finishedAt,exitCode:$exitCode,elapsedSeconds:$elapsedSeconds}' >"$log/end.json"
        emit "$(jq -cs '.[0]+.[1]+{type:"command-end",message:("Finished "+.[0].command)} | del(.cwd)' "$log/start.json" "$log/end.json")"
    fi
    LAST_COMMAND_ID=${log##*/}
    LAST_ERROR=$error_file
    LAST_STATUS=$status
    # BusyBox returns the terminating signal status; GNU timeout returns 124.
    # Treat a signal exit as a deadline only after this command's budget elapsed.
    LAST_TIMEOUT=false
    if ((status == 124)) || { ((status == 137 || status == 143)) && ((SECONDS-started >= seconds)); }; then
        LAST_TIMEOUT=true
    fi
    if ((status != 0)); then
        return "$status"
    fi
}

run() {
    local seconds=$1
    shift
    local output
    output=$(mktemp "$WORKDIR/command-output.XXXXXX")
    rm -f "$WORKDIR/error.json"
    local status=0 attempt reason repeatable=false
    case "${1##*/}" in
        kubectl) [[ " $* " == *' apply '* ]] && repeatable=true ;;
        git) [[ " $* " == *' fetch '* ]] && repeatable=true ;;
        helm) case "${2:-}" in pull|repo|dependency) repeatable=true ;; esac ;;
    esac
    for attempt in 1 2 3 4 5; do
        status=0
        run_capture "$output" "$seconds" "$@" || status=$?
        ((status!=0)) || break
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        [[ $repeatable == true ]] && retryable_api_reason "$reason" && ((attempt<5)) || break
        emit "$(jq -cn --arg command "${1##*/}" --arg reason "$reason" --argjson attempt "$attempt" \
            '{type:"command-retry",command:$command,reason:$reason,attempt:$attempt}')"
        sleep "$((attempt*2))"
        if [[ ${1##*/} == kubectl && -n ${ESB_LEASE_HOLDER:-} ]]; then verify_lease || return 1; fi
    done
    if ((status!=0)); then
        # Internal bootstrap hooks write their specific result in this directory.
        if [[ -s $WORKDIR/error.json ]] && jq -e '
            type=="object" and .status=="failed" and
            (.code|type)=="string" and (.message|type)=="string"' "$WORKDIR/error.json" >/dev/null; then
            return 1
        fi
        command_failure COMMAND_FAILED "${1##*/} failed (exit $LAST_STATUS${LAST_COMMAND_ID:+, command $LAST_COMMAND_ID}): $(safe_error "$LAST_ERROR"). See output 3 for the full log."
        return 1
    fi
}

kube_json() {
    local output=$1
    shift
    local status=0
    if kube_query "$@"; then
        read_capture "$output" 30 "${ESB_READ_BUDGET:-120}" kubectl "$@" || status=$?
    else
        run_capture "$output" 30 kubectl "$@" || status=$?
    fi
    if ((status != 0)); then
        command_failure KUBERNETES "Kubernetes request failed (exit $status, command ${LAST_COMMAND_ID:-unrecorded}): $(safe_error "$LAST_ERROR"). See output 3."
        return 1
    fi
    [[ -s $output ]] || printf 'null\n' >"$output"
    jq -e 'type == "object" or . == null' "$output" >/dev/null ||
        fail API_RESPONSE 'Kubernetes returned an invalid resource document.'
}

get_optional() {
    local output=$1 namespace=$2 kind=$3 name=$4
    local args=()
    [[ -z $namespace ]] || args+=(-n "$namespace")
    kube_json "$output" "${args[@]}" get "$kind" "$name" --ignore-not-found -o json
}

apply_json() {
    run 60 kubectl apply --field-manager=esb-ocmwstack -f "$1"
}

check_tools() {
    local command missing=0
    local report='[]'
    for command in bash node npm jq curl git helm kubectl openssl base64 sha256sum timeout setsid nc busybox; do
        local available=false
        if command -v "$command" >/dev/null 2>&1; then
            available=true
        else
            missing=1
        fi
        report=$(jq -c --arg name "$command" --argjson available "$available" \
            '. + [{name:$name,available:$available}]' <<<"$report")
    done
    jq -n --arg bash "$BASH_VERSION" --argjson tools "$report" \
        '{bash:$bash,tools:$tools}'
    return "$missing"
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM ERR
    [[ -z $CURRENT_PID ]] || kill -TERM "$CURRENT_PID" 2>/dev/null || true
    [[ -z $LEASE_PID ]] || kill -TERM "$LEASE_PID" 2>/dev/null || true
    local pid
    for pid in "${TUNNEL_PIDS[@]}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    [[ -z $CURRENT_PID ]] || wait "$CURRENT_PID" 2>/dev/null || true
    [[ -z $LEASE_PID ]] || wait "$LEASE_PID" 2>/dev/null || true
    if [[ $OWNS_WORKDIR == true ]]; then
        # Publish the original failure before lease cleanup can fail or replace
        # command diagnostics. The node can also read this private result file.
        if ((status != 0)) && [[ $RESULT_WRITTEN != true ]]; then
            if [[ -s $WORKDIR/error.json ]] && jq -e '
                type=="object" and .status=="failed" and
                (.code|type)=="string" and (.message|type)=="string"
            ' "$WORKDIR/error.json" >/dev/null 2>&1; then
                cp "$WORKDIR/error.json" "$WORKDIR/failure-result.json"
            else
                jq -cn --argjson exitCode "$status" \
                    '{status:"failed",code:"COMMAND_FAILED",exitCode:$exitCode,message:"Deployment stopped; see progress for the last completed phase."}' >"$WORKDIR/failure-result.json"
            fi
            if [[ -n ${ESB_RESULT_FILE:-} ]]; then
                cp "$WORKDIR/failure-result.json" "$ESB_RESULT_FILE"
            fi
            cat "$WORKDIR/failure-result.json" >&"${RESULT_FD:-1}"
            RESULT_WRITTEN=true
        fi
        if [[ -n ${ESB_LEASE_HOLDER:-} ]]; then
            release_lease || true
        fi
        rm -rf -- "$WORKDIR"
    fi
    exit "$status"
}

cancel() {
    if [[ ! -f $WORKDIR/lease-lost ]]; then
        fail CANCELLED 'Operation cancelled; cluster resources are retained.' || true
    fi
    exit 130
}

prepare_deployment_assets() {
    export JSON_LIB_DIR="$WORKDIR/json-lib"
    mkdir -p "$JSON_LIB_DIR"
    local name source temporary
    for name in filters.jq readiness.jq upstream.patch; do
        [[ -s $JSON_LIB_DIR/$name ]] && continue
        case $name in filters.jq) source=filters ;; readiness.jq) source=readiness ;; *) source=upstream-patch ;; esac
        temporary=$(mktemp "$JSON_LIB_DIR/.asset.XXXXXX")
        bash "$DEPLOYMENT/assets.sh" "$source" >"$temporary"
        mv -f "$temporary" "$JSON_LIB_DIR/$name"
    done
}

load_libraries() {
    if [[ -n ${WORKDIR:-} ]]; then prepare_deployment_assets; fi
    local name
    for name in cluster recovery kyverno network services runtime checks; do
        # shellcheck source=/dev/null
        source "$DEPLOYMENT/$name.sh"
    done
}
