#!/usr/bin/env bash
# Readiness, registry access and explicit credential lifecycle checks.

# A server-side apply can install part of a manifest before a transport failure.
# Reapply the same local manifest after readiness and lease checks; never replay
# arbitrary commands or alter cluster-admin/system RBAC to make the write pass.
argo_apply() {
    local manifest=$1 started=$SECONDS attempt reason remaining seconds delay retryable
    local budget=${2:-$TIMEOUT_SECONDS} attempts=5
    [[ -f $WORKDIR/api-failures.json ]] || printf '[]\n' >"$WORKDIR/api-failures.json"
    for ((attempt=1; attempt<=attempts; attempt++)); do
        remaining=$((budget-(SECONDS-started)))
        ((remaining>0)) || break
        seconds=$((remaining<300 ? remaining : 300))
        wait_api_ready argocd argocd "$seconds" || return 1
        verify_lease || return 1
        remaining=$((budget-(SECONDS-started)))
        ((remaining>0)) || break
        seconds=$((remaining<120 ? remaining : 120))
        emit "$(jq -cn --argjson attempt "$attempt" --argjson attempts "$attempts" \
            --arg manifest "${manifest##*/}" '{type:"argo-install",phase:"argo-install",manifest:$manifest,attempt:$attempt,attempts:$attempts}')"
        if run_capture "$WORKDIR/argo-apply-output" "$seconds" kubectl apply -n argocd \
            --server-side --force-conflicts -f "$manifest" --request-timeout=20s; then
            cat "$WORKDIR/argo-apply-output"
            return 0
        fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        retryable=false
        retryable_api_reason "$reason" && retryable=true
        if [[ $reason == authorization ]] && grep -Eq \
            'clusterrole\.rbac\.authorization\.k8s\.io "(cluster-admin|system:(basic-user|discovery|public-info-viewer|service-account-issuer-discovery))" not found' "$LAST_ERROR"; then
            reason=default-rbac-unavailable
            retryable=true
        fi
        record_api_failure argo-install argocd argocd "$attempt" "$attempts" "$reason" "$retryable"
        if [[ $retryable != true ]]; then
            fail_api_command ARGO_INSTALL "Argo CD manifest application failed: $reason. See output 3."
            return 1
        fi
        remaining=$((budget-(SECONDS-started)))
        ((attempt<attempts && remaining>0)) || break
        delay=$((attempt*5))
        ((delay<=remaining)) || delay=$remaining
        emit "$(jq -cn --arg reason "$reason" --argjson delaySeconds "$delay" \
            --argjson remainingSeconds "$remaining" '{type:"argo-install-retry",phase:"argo-install",
                reason:$reason,delaySeconds:$delaySeconds,remainingSeconds:$remainingSeconds}')"
        sleep "$delay"
    done
    fail_api_command ARGO_INSTALL "Argo CD manifest application did not recover within its retry budget. See output 3."
}

argo_prepare_manifest() {
    # The reviewed upstream manifest contains top-level YAML document separators.
    # Helm's YAML parser handles each document; no additional runtime is needed.
    jq -Rs 'split("\n---\n") | to_entries | map({key:(.key|tostring),value:.value}) | from_entries' \
        "$ESB_ARGO_MANIFEST" >"$WORKDIR/argo-yaml.json" || return 1
    read_yaml "$WORKDIR/argo-yaml.json" "$WORKDIR/argo-documents.json" || return 1
    jq '[.[] | select(.apiVersion!=null and .kind!=null)]' "$WORKDIR/argo-documents.json" >"$WORKDIR/argo-objects.json" || return 1
    jq '{apiVersion:"v1",kind:"List",items:[.[] | select(.kind!="Deployment" and .kind!="StatefulSet")]}' \
        "$WORKDIR/argo-objects.json" >"$WORKDIR/argo-prerequisites.json" || return 1
    jq '{apiVersion:"v1",kind:"List",items:[.[] | select(.kind=="Deployment" or .kind=="StatefulSet")]}' \
        "$WORKDIR/argo-objects.json" >"$WORKDIR/argo-workloads.json" || return 1
    jq -e '.items|length==7 and all(.[]; .metadata.labels["app.kubernetes.io/part-of"]=="argocd")' \
        "$WORKDIR/argo-workloads.json" >/dev/null || { fail ARGO_MANIFEST 'Unexpected Argo workload list.'; return 1; }
    jq -r '.items[] | .kind+"/"+.metadata.name' "$WORKDIR/argo-prerequisites.json" | LC_ALL=C sort >"$WORKDIR/argo-required.txt"
    [[ -s $WORKDIR/argo-required.txt ]] || { fail ARGO_MANIFEST 'Argo prerequisites are missing from the manifest.'; return 1; }
}

argo_install() {
    phase argo-install
    [[ ${ESB_ARGO_MANIFEST:-} == "$WORKDIR/argo-install.yaml" && -s $ESB_ARGO_MANIFEST ]] ||
        { fail ARGO_MANIFEST 'The preflight Argo CD manifest is unavailable.'; return 1; }
    local expected actual started=$SECONDS remaining limit reason='' delay missing='[]' next_apply=0
    expected=$(jq -er '.argoManifestSha256' "$WORKDIR/chart-report.json") || return 1
    actual=$(sha256sum "$ESB_ARGO_MANIFEST" | cut -d ' ' -f 1)
    [[ $expected == "$actual" ]] || { fail ARGO_MANIFEST 'The preflight Argo CD manifest changed.'; return 1; }
    argo_prepare_manifest || return 1
    printf '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"argocd"}}\n' >"$WORKDIR/argo-namespace.json"
    remaining=$((TIMEOUT_SECONDS-(SECONDS-started)))
    ((remaining>0)) || { fail ARGO_INSTALL 'Argo manifest preparation timed out.'; return 1; }
    argo_apply "$WORKDIR/argo-namespace.json" "$remaining" || return 1
    while ((SECONDS-started<TIMEOUT_SECONDS)); do
        remaining=$((TIMEOUT_SECONDS-(SECONDS-started)))
        if ((SECONDS>=next_apply)); then
            argo_apply "$WORKDIR/argo-prerequisites.json" "$remaining" || return 1
            next_apply=$((SECONDS+30))
        fi
        remaining=$((TIMEOUT_SECONDS-(SECONDS-started)))
        ((remaining>0)) || break
        limit=$((remaining<30 ? remaining : 30))
        # Print only names, including for Secrets. A successful partial List is
        # insufficient: every object from the prerequisite manifest must exist.
        if run_capture "$WORKDIR/argo-present.txt" "$limit" kubectl get -n argocd \
            -f "$WORKDIR/argo-prerequisites.json" --ignore-not-found \
            -o 'jsonpath={range .items[*]}{.kind}{"/"}{.metadata.name}{"\n"}{end}' "--request-timeout=${limit}s"; then
            reason=''
            missing=$(jq -Rsc --rawfile present "$WORKDIR/argo-present.txt" \
                '(split("\n")|map(select(length>0))) - ($present|split("\n"))' "$WORKDIR/argo-required.txt") || return 1
            if [[ $missing == '[]' ]]; then
                remaining=$((TIMEOUT_SECONDS-(SECONDS-started)))
                ((remaining>0)) || break
                argo_apply "$WORKDIR/argo-workloads.json" "$remaining" || return 1
                emit '{"type":"argo-prerequisites","ready":true,"missing":[]}'
                return 0
            fi
        else
            reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
            if ! retryable_readiness_reason "$reason"; then
                fail ARGO_PREREQUISITES "Cannot verify Argo prerequisites: $reason; see output 3."
                return 1
            fi
        fi
        remaining=$((TIMEOUT_SECONDS-(SECONDS-started)))
        ((remaining>0)) || break
        emit "$(jq -cn --argjson missing "$missing" --arg reason "$reason" --argjson remaining "$remaining" \
            '{type:"argo-prerequisites",ready:false,missing:$missing,apiReason:$reason,remainingSeconds:$remaining}')"
        delay=$((remaining<5 ? remaining : 5)); sleep "$delay"
    done
    jq -cn --argjson missing "$missing" --arg reason "$reason" \
        '{status:"failed",code:"ARGO_PREREQUISITES",message:"Argo prerequisites did not become readable within the configured timeout. See output 3.",
          diagnostics:{missing:$missing,lastApiReason:$reason}}' >"$WORKDIR/error.json"
    return 1
}

registry_request() {
    local method=$1 url=$2 token_request=${3:-false}
    local args=(--disable --silent --show-error --max-time 30 --max-filesize 4194304
        --proto '=https' --dump-header "$WORKDIR/registry-headers" --output "$WORKDIR/registry-body"
        --write-out '%{http_code}')
    [[ $method != HEAD ]] || args+=(--head)
    if [[ $token_request != true ]]; then
        args+=(--header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json')
        [[ ! -s $WORKDIR/registry-auth ]] || args+=(--header "@$WORKDIR/registry-auth")
    fi
    run_capture "$WORKDIR/registry-status" 35 curl "${args[@]}" "$url" ||
        { fail REGISTRY_CONNECTION 'The policy image registry request failed.'; return 1; }
    [[ $(cat "$WORKDIR/registry-status") =~ ^[1-5][0-9][0-9]$ ]] ||
        fail REGISTRY_RESPONSE 'The registry returned no HTTP status.'
}

registry_authenticate() {
    # Parse only the last HTTP response; proxy CONNECT responses may precede it.
    jq -eRrs '
        split("\r\n\r\n") | map(select(test("^HTTP/\\S+ [0-9]{3}"))) | last |
        split("\r\n") | map(select(test("^www-authenticate: *Bearer +";"i"))) |
        if length!=1 then error("Expected one Bearer challenge") else .[0] end |
        sub("^www-authenticate: *Bearer +";"";"i") |
        def fields:
            if test("^\\s*$") then [] else
                capture("^\\s*(?<key>[a-zA-Z][a-zA-Z0-9_-]*)\\s*=\\s*(?<value>\"(?:[^\"\\\\]|\\\\.)*\"|[^,\\s]+)\\s*(?:,|$)(?<rest>.*)$") as $field |
                [{key:($field.key|ascii_downcase),value:($field.value |
                    if startswith("\"") then .[1:-1] | gsub("\\\\(?<character>.)";.character) else . end)}] +
                ($field.rest|fields)
            end;
        fields | if length==0 or (group_by(.key)|any(length>1)) then error("Invalid challenge fields") else from_entries end |
        if (.realm|type)!="string" or (.realm|test("^https://[^/@?#\\s]+(?:/[^#\\s]*)?$")|not)
        then error("Expected an HTTPS token endpoint") else . end
    ' "$WORKDIR/registry-headers" >"$WORKDIR/registry-challenge.json" ||
        { fail REGISTRY_CHALLENGE 'The registry returned an unsupported Bearer challenge.'; return 1; }
    local realm base query pair key decoded retained=''
    realm=$(jq -r '.realm' "$WORKDIR/registry-challenge.json")
    base=${realm%%\?*}
    if [[ $realm == *\?* ]]; then
        query=${realm#*\?}
        while IFS= read -r pair; do
            key=${pair%%=*}
            [[ ! $key =~ %([^[:xdigit:]]|[[:xdigit:]]$|$) ]] || return 1
            decoded=$(printf '%b' "${key//%/\\x}")
            case "$decoded" in account|offline_token|scope|service) continue ;; esac
            retained+="${retained:+&}$pair"
        done < <(printf '%s\n' "$query" | tr '&' '\n')
    fi
    query="${retained:+$retained&}scope=repository%3Atsa%2Fpolicy%3Apull"
    if jq -e '.service|type=="string" and length>0' "$WORKDIR/registry-challenge.json" >/dev/null; then
        query+="&service=$(jq -r '.service|@uri' "$WORKDIR/registry-challenge.json")"
    fi
    registry_request GET "$base?$query" true
    [[ $(cat "$WORKDIR/registry-status") == 200 ]] ||
        { fail REGISTRY_AUTH 'The policy registry did not grant anonymous pull access.'; return 1; }
    jq -er '(.token // .access_token) | select(type=="string" and length>0 and (test("[\\s\\x00-\\x1f\\x7f]")|not)) |
        "Authorization: Bearer " + .' "$WORKDIR/registry-body" >"$WORKDIR/registry-auth" ||
        { fail REGISTRY_TOKEN 'The registry returned an unusable bearer token.'; return 1; }
}

policy_image_preflight() {
    local registry=node-654e3bca7fbeeed18f81d7c7.ps-xaas.io method status
    local url="https://node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/v2/tsa/policy/manifests/1.1.2"
    rm -f "$WORKDIR/registry-auth"
    for method in HEAD GET; do
        registry_request "$method" "$url"
        status=$(cat "$WORKDIR/registry-status")
        if [[ $status == 401 && ! -s $WORKDIR/registry-auth ]]; then
            registry_authenticate
            registry_request "$method" "$url"
            status=$(cat "$WORKDIR/registry-status")
        fi
        [[ $status == 200 ]] || { fail POLICY_IMAGE "Policy manifest $method returned HTTP $status."; return 1; }
    done
    jq -e '
        def image: IN("application/vnd.oci.image.manifest.v1+json","application/vnd.docker.distribution.manifest.v2+json");
        .schemaVersion==2 and
        (.mediaType==null or (.mediaType|image) or (.mediaType|IN("application/vnd.oci.image.index.v1+json","application/vnd.docker.distribution.manifest.list.v2+json"))) and
        (if .config then .config.mediaType|IN("application/vnd.oci.image.config.v1+json","application/vnd.docker.container.image.v1+json")
         else any(.manifests[]?; (.mediaType|image) and .artifactType==null) end)
    ' "$WORKDIR/registry-body" >/dev/null || { fail POLICY_IMAGE 'The policy tag has no container image manifest.'; return 1; }
    local authentication=anonymous
    [[ ! -s $WORKDIR/registry-auth ]] || authentication=anonymous-bearer
    emit "$(jq -cn --arg image "$registry/tsa/policy:1.1.2" --arg authentication "$authentication" \
        '{type:"image-preflight",image:$image,authentication:$authentication}')"
    rm -f "$WORKDIR/registry-auth" "$WORKDIR/registry-body"
}

kube_read() {
    local endpoint=$1 established=${2:-false} budget=${3:-120}
    [[ $endpoint == /api/v1/namespaces/argocd/pods ||
       $endpoint =~ ^/apis/argoproj.io/v1alpha1/namespaces/[a-z0-9-]+/(applications|applicationsets)$ ||
       $endpoint =~ ^/apis/apiextensions.k8s.io/v1/customresourcedefinitions/(applications|applicationsets|appprojects).argoproj.io$ ]] ||
        { fail API_READ_PATH 'Unsupported Argo readiness API path.'; return 1; }
    [[ $budget =~ ^[0-9]+$ && $budget -gt 0 ]] || return 1
    local deadline=$((SECONDS+budget)) attempt=0 forbidden=0 remaining seconds reason
    while ((SECONDS < deadline)); do
        remaining=$((deadline-SECONDS))
        seconds=$((remaining < 10 ? remaining : 10))
        if run_capture "$WORKDIR/argo-read.json" "$remaining" kubectl get "--raw=$endpoint" "--request-timeout=${seconds}s"; then
            jq -e 'type=="object"' "$WORKDIR/argo-read.json" >/dev/null ||
                { fail API_READ_RESPONSE 'Argo API returned invalid JSON.'; return 1; }
            if [[ $established == true ]]; then
                if jq -e 'any(.status.conditions[]?; .type=="Established" and .status=="True")' "$WORKDIR/argo-read.json" >/dev/null; then
                    cat "$WORKDIR/argo-read.json"
                    return
                fi
                reason='Argo CRD is not Established'
            else
                jq -e '.items|type=="array"' "$WORKDIR/argo-read.json" >/dev/null ||
                    { fail API_READ_RESPONSE 'Argo API returned no resource list.'; return 1; }
                if ((forbidden > 0)); then
                    emit "$(jq -cn --arg endpoint "$endpoint" --argjson count "$forbidden" \
                        '{type:"api-read-recovered",endpoint:$endpoint,forbiddenResponses:$count}')"
                fi
                cat "$WORKDIR/argo-read.json"
                return
            fi
        else
            reason='Kubernetes API request is not ready'
            if grep -Eiq 'unauthorized|x509:' "$LAST_ERROR"; then
                fail API_AUTHENTICATION 'Argo read authentication or certificate verification failed.'
                return 1
            elif grep -iq forbidden "$LAST_ERROR"; then
                [[ $endpoint =~ ^/apis/argoproj.io/v1alpha1/namespaces/([a-z0-9-]+)/(applications|applicationsets)$ ]] ||
                    { fail RBAC 'Argo readiness read was denied.'; return 1; }
                local namespace=${BASH_REMATCH[1]} resource=${BASH_REMATCH[2]}
                [[ -n ${ESB_KUBE_USERNAME:-} ]] || { fail KUBE_IDENTITY 'Expected Kubernetes identity is unavailable.'; return 1; }
                kube_identity
                access_review "$(jq -cn --arg namespace "$namespace" --arg resource "$resource" \
                    '{group:"argoproj.io",version:"v1alpha1",namespace:$namespace,resource:$resource,verb:"list"}')"
                forbidden=$((forbidden+1))
                ((forbidden <= 3)) || { fail ARGO_ACCESS_INCONSISTENT 'Argo list reads remain denied after allowed authorization reviews.'; return 1; }
                reason='Retrying the authorized Argo list request'
            elif ! transport_failure "$LAST_ERROR" && [[ $LAST_STATUS != 124 ]] &&
                ! grep -Eiq "NotFound|could not find the requested resource|couldn't get current server API group list: unknown|doesn't have a resource type|an error on the server.*unknown" "$LAST_ERROR"; then
                fail ARGO_API_UNAVAILABLE 'Argo readiness read failed.'
                return 1
            fi
        fi
        attempt=$((attempt+1))
        emit "$(jq -cn --arg endpoint "$endpoint" --arg reason "$reason" --argjson attempt "$attempt" \
            '{type:"api-read-retry",endpoint:$endpoint,reason:$reason,attempt:$attempt}')"
        remaining=$((deadline-SECONDS))
        ((remaining > 0)) && sleep "$((remaining<5 ? remaining : 5))"
    done
    fail ARGO_API_UNAVAILABLE 'Argo API readiness exhausted its read budget.'
}

# Only reads are retried here. The caller has already installed the workload.
# Keep one deadline across all required components, including interrupted reads.
wait_workloads() {
    local namespace=$1 resource=$2 selector=${3:-} expected=${4:-'[]'} budget=${5:-$TIMEOUT_SECONDS}
    local deadline=$((SECONDS+budget)) remaining limit delay reason='' attempt=0 directory
    directory=$(mktemp -d "$WORKDIR/workload-wait.XXXXXX") || return 1
    printf '{"ready":false,"missing":[],"workloads":[]}\n' >"$directory/report.json"
    local args=(get "$resource" -n "$namespace" -o json)
    [[ $resource != */* ]] || args+=(--ignore-not-found)
    [[ -z $selector ]] || args+=(-l "$selector")
    phase "waiting-for-$namespace"
    while ((SECONDS<deadline)); do
        remaining=$((deadline-SECONDS)); limit=$((remaining<15 ? remaining : 15))
        attempt=$((attempt+1))
        if run_capture "$directory/objects.json" "$limit" kubectl "${args[@]}" "--request-timeout=${limit}s"; then
            reason=''
            [[ -s $directory/objects.json ]] || printf '{"items":[]}\n' >"$directory/objects.json"
            if [[ $resource == */* ]]; then
                jq 'if has("items") then . else {items:[.]} end' "$directory/objects.json" >"$directory/list.json" || return 1
                mv "$directory/list.json" "$directory/objects.json"
            fi
            if ! jq -e 'type=="object" and (.items|type=="array") and all(.items[];
                (.metadata.name|type)=="string" and
                (.kind=="Pod" or (.metadata.generation|type)=="number"))' "$directory/objects.json" >/dev/null; then
                fail WORKLOAD_RESPONSE "Invalid workload response for $namespace; see output 3."
                return 1
            fi
            jq -L "$JSON_LIB_DIR" --argjson expected "$expected" 'include "readiness"; workload_report($expected)' \
                "$directory/objects.json" >"$directory/report.json" || return 1
            if jq -e '.ready' "$directory/report.json" >/dev/null; then
                emit "$(jq -c --arg namespace "$namespace" '.+{type:"workloads-ready",namespace:$namespace}' "$directory/report.json")"
                return 0
            fi
        else
            reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
            if ! retryable_readiness_reason "$reason"; then
                fail WORKLOAD_READ "Cannot read workloads in $namespace: $reason; see output 3." || true
                workload_diagnostics "$namespace" "$selector" || true
                return 1
            fi
        fi
        remaining=$((deadline-SECONDS)); ((remaining>=0)) || remaining=0
        emit "$(jq -c --arg namespace "$namespace" --arg reason "$reason" --argjson remaining "$remaining" \
            --argjson attempt "$attempt" '.+{type:"workload-wait",namespace:$namespace,
              apiReason:$reason,attempt:$attempt,remainingSeconds:$remaining,
              message:("Waiting for "+$namespace+" workloads ("+($remaining|tostring)+"s remaining)")}' "$directory/report.json")"
        ((remaining>0)) || break
        delay=$((remaining<5 ? remaining : 5)); sleep "$delay"
    done
    jq -cn --arg namespace "$namespace" --arg reason "$reason" --argjson budget "$budget" \
        --slurpfile report "$directory/report.json" \
        '{status:"failed",code:"WORKLOAD_TIMEOUT",
          message:("Workloads in "+$namespace+" did not become Ready within "+($budget|tostring)+" seconds. See output 3 for pod events and logs."),
          diagnostics:{namespace:$namespace,timeoutSeconds:$budget,lastApiReason:$reason,readiness:$report[0]}}' >"$WORKDIR/error.json"
    workload_diagnostics "$namespace" "$selector" || true
    return 1
}

# Diagnostics use the uploaded kubeconfig through the same command wrapper.
# An unavailable log must never replace the original failure or extend a wait
# indefinitely. Secret objects are not requested; raw pod responses stay in
# the private command log alongside the other unredacted command output.
workload_diagnostics() {
    local namespace=$1 selector=${2:-} deadline=$((SECONDS+60)) directory remaining limit pod container previous
    directory=$(mktemp -d "$WORKDIR/workload-diagnostics.XXXXXX") || return 0
    local args=(get pods -n "$namespace" -o json)
    [[ -z $selector ]] || args+=(-l "$selector")
    printf '\nWorkload diagnostics: %s\n' "$namespace" >&2
    if run_capture "$directory/pods.json" 10 kubectl "${args[@]}" --request-timeout=8s; then
        jq -L "$JSON_LIB_DIR" 'include "readiness"; pod_problems' "$directory/pods.json" >"$directory/problems.json" || printf '[]\n' >"$directory/problems.json"
        cat "$directory/problems.json" >&2
    else
        printf 'Pod diagnostics unavailable (exit %s).\n' "$LAST_STATUS" >&2
        printf '[]\n' >"$directory/problems.json"
    fi
    if run_capture "$directory/events.json" 10 kubectl get events -n "$namespace" \
        --field-selector=type=Warning -o json --request-timeout=8s; then
        jq '[.items[]? | {at:(.lastTimestamp // .eventTime // .metadata.creationTimestamp),
            object:.involvedObject,reason,message,count}] | sort_by(.at) | .[-40:]' "$directory/events.json" >&2 || true
    fi
    # Prioritize previous crash logs before current logs; include init containers.
    while IFS=$'\t' read -r pod container previous; do
        remaining=$((deadline-SECONDS)); ((remaining>0)) || break
        limit=$((remaining<8 ? remaining : 8))
        args=(logs -n "$namespace" "$pod" -c "$container" --timestamps --tail=100 --limit-bytes=32768 "--request-timeout=${limit}s")
        [[ $previous != true ]] || args+=(--previous)
        printf '\nContainer log: %s/%s previous=%s\n' "$pod" "$container" "$previous" >&2
        if run_capture "$directory/container.log" "$limit" kubectl "${args[@]}"; then
            cat "$directory/container.log" >&2
        else
            printf 'Log unavailable (exit %s); command details are recorded.\n' "$LAST_STATUS" >&2
        fi
    done < <(jq -r '[.[] | .name as $pod | .containers[] |
        select(.ready!=true or .restartCount>0) |
        (if .restartCount>0 then [$pod,.name,"true"] else empty end),[$pod,.name,"false"]] |
        .[:24][] | @tsv' "$directory/problems.json")
    return 0
}

argo_health() {
    if [[ ${1:-false} == true ]]; then
        workload_diagnostics argocd app.kubernetes.io/part-of=argocd
        return
    fi
    wait_workloads argocd deployments,statefulsets app.kubernetes.io/part-of=argocd \
        '["Deployment/argocd-redis","Deployment/argocd-dex-server","Deployment/argocd-server",
          "Deployment/argocd-repo-server","Deployment/argocd-applicationset-controller",
          "Deployment/argocd-notifications-controller","StatefulSet/argocd-application-controller"]'
}

diagnose_api() {
    printf '[]\n' >"$WORKDIR/api-checks.json"
    local sample started elapsed ok reason status
    for sample in 1 2 3 4 5; do
        started=$SECONDS
        ok=false reason='' status=0
        if run_capture "$WORKDIR/api-ready" 12 kubectl get --raw=/readyz --request-timeout=10s; then
            ok=true
        else
            status=$?
            reason=$(api_failure_reason "$LAST_ERROR" "$status")
        fi
        elapsed=$(((SECONDS-started)*1000))
        jq --arg at "$(timestamp)" --argjson ok "$ok" --argjson elapsed "$elapsed" \
            --arg reason "$reason" --argjson status "$status" \
            '.+[{at:$at,ok:$ok,elapsedMs:$elapsed,exitCode:$status}
               + (if $ok then {} else {reason:$reason} end)]' \
            "$WORKDIR/api-checks.json" >"$WORKDIR/api-checks-next.json"
        mv "$WORKDIR/api-checks-next.json" "$WORKDIR/api-checks.json"
        ((sample == 5)) || sleep 2
    done
    jq '{status:(if all(.ok) then "api-reachable" else "api-unreliable" end),checks:.,
        detail:"Readiness probes use the uploaded kubeconfig."}' "$WORKDIR/api-checks.json"
}

http_json() {
    local output=$1 method=$2 url=$3 body=${4:-} seconds=${5:-20}
    local args=(--disable --silent --show-error --max-time "$seconds" --max-filesize 4194304
        --proto '=http,https' --request "$method" --output "$WORKDIR/http-body" --write-out '%{http_code}')
    [[ -z $body ]] || args+=(--header 'Content-Type: application/json' --data-binary "@$body")
    local status=0
    if run_capture "$WORKDIR/http-status" "$((seconds+3))" curl "${args[@]}" "$url"; then
        status=$(cat "$WORKDIR/http-status")
        [[ $status =~ ^[1-5][0-9][0-9]$ ]] || status=0
    fi
    if ! jq -e -s 'length==1' "$WORKDIR/http-body" >/dev/null 2>&1; then printf 'null\n' >"$WORKDIR/http-body"; fi
    jq -n --argjson status "$status" --slurpfile data "$WORKDIR/http-body" \
        '{status:$status,ok:($status>=200 and $status<300),data:$data[0]}' >"$output"
}

http_check() {
    local collection=$1 name=$2 url=$3 predicate=$4 method=${5:-GET} body=${6:-}
    http_json "$WORKDIR/check-response.json" "$method" "$url" "$body"
    jq --arg name "$name" ". as \$response | {name:\$name,httpStatus:.status,ok:(.ok and (try (.data|$predicate) catch false))}" \
        "$WORKDIR/check-response.json" >"$WORKDIR/check.json"
    jq --slurpfile check "$WORKDIR/check.json" '.+[$check[0]]' "$collection" >"$WORKDIR/checks-next.json"
    mv "$WORKDIR/checks-next.json" "$collection"
}

inspect_stack() {
    guard_status
    cp "$WORKDIR/guard-status.json" "$WORKDIR/operational.json"
    kube_json "$WORKDIR/inspect-apps.json" -n argocd get applications.argoproj.io -o json
    kube_json "$WORKDIR/inspect-pods.json" get pods -A -o json
    kube_json "$WORKDIR/inspect-pvcs.json" get pvc -A -o json
    kube_json "$WORKDIR/inspect-jobs.json" get jobs -A -o json
    get_optional "$WORKDIR/inspect-gateway.json" infrastructure gateway envoy-gateway
    emit "$(jq -c '{type:"public-access",gatewayAddresses:(.status.addresses // [])}' "$WORKDIR/inspect-gateway.json")"
    get_optional "$WORKDIR/inspect-cert.json" ocm-wstack secret "esb-$(config_value '.tenantRelease')-tls"
    get_optional "$WORKDIR/inspect-proxy.json" infrastructure envoyproxy envoy
    get_optional "$WORKDIR/inspect-policy.json" '' clusterpolicy esb-ocm-envoy-traffic
    kube_json "$WORKDIR/inspect-services.json" -n infrastructure get services \
        -l gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure -o json
    jq -n -L "$JSON_LIB_DIR" --slurpfile c "$CONFIG" --slurpfile lock "$ROOT/upstream-lock.json" \
        --slurpfile apps "$WORKDIR/inspect-apps.json" --slurpfile pods "$WORKDIR/inspect-pods.json" \
        --slurpfile pvcs "$WORKDIR/inspect-pvcs.json" --slurpfile jobs "$WORKDIR/inspect-jobs.json" \
        --slurpfile gateway "$WORKDIR/inspect-gateway.json" --slurpfile certificate "$WORKDIR/inspect-cert.json" \
        --slurpfile proxy "$WORKDIR/inspect-proxy.json" --slurpfile policy "$WORKDIR/inspect-policy.json" \
        --slurpfile services "$WORKDIR/inspect-services.json" --slurpfile operational "$WORKDIR/operational.json" \
        'include "filters"; inspect_report($c[0];$lock[0];$apps[0];$pods[0];$pvcs[0];$jobs[0];$gateway[0];$certificate[0];$proxy[0];$policy[0];$services[0];$operational[0])' >"$WORKDIR/inspect-report.json"
    local ready=false
    if (
        set -e
        jq -er '.data["tls.crt"]' "$WORKDIR/inspect-cert.json" | base64 -d >"$WORKDIR/inspect-cert.pem"
        jq -er '.data["tls.key"]' "$WORKDIR/inspect-cert.json" | base64 -d >"$WORKDIR/inspect-key.pem"
        tls_validate "$WORKDIR/inspect-cert.pem" "$WORKDIR/inspect-key.pem" "$(config_value '.tenantHost')"
    ) 2>"$WORKDIR/inspect-tls-error"; then ready=true; fi
    jq --argjson ready "$ready" '.certificateReady=(.certificateReady and $ready)' "$WORKDIR/inspect-report.json"
}

validate_stack() {
    inspect_stack >"$WORKDIR/inspection.json"
    local tenant host domain
    tenant=$(config_value '.tenantUrl')
    host=$(config_value '.tenantHost')
    domain=$(config_value '.domain')
    printf '[]\n' >"$WORKDIR/native-checks.json"
    http_check "$WORKDIR/native-checks.json" issuer-metadata "$tenant/.well-known/openid-credential-issuer" \
        ".credential_issuer==\"$tenant\" and .credential_endpoint==\"$tenant/api/credential\" and (.credential_configurations_supported|length)>0"
    http_check "$WORKDIR/native-checks.json" did-document "$tenant/.well-known/did.json" \
        ".id==\"did:web:$host\" and (.verificationMethod|type)==\"array\" and (.verificationMethod|length)>0"
    http_check "$WORKDIR/native-checks.json" jwks "$tenant/.well-known/jwks.json" '(.keys|type)=="array" and (.keys|length)>0'
    printf '[]\n' >"$WORKDIR/ui-checks.json"
    http_check "$WORKDIR/ui-checks.json" ui-ready "$tenant/orce/ui-api/v1/health/ready" '.ready==true'
    jq --slurpfile response "$WORKDIR/check-response.json" '.[0]+={nativeReady:($response[0].data.nativeReady==true),dependencies:($response[0].data.dependencies // [])}' \
        "$WORKDIR/ui-checks.json" >"$WORKDIR/ui-checks-next.json"
    mv "$WORKDIR/ui-checks-next.json" "$WORKDIR/ui-checks.json"
    http_check "$WORKDIR/ui-checks.json" ui-auth "$tenant/orce/ui-api/v1/auth/config" \
        '.data.mode=="local-session" and .data.sessionHours==24 and .data.features.pcm==false'
    api_auth_checks "$tenant" "$WORKDIR/ui-checks.json"
    printf '[]\n' >"$WORKDIR/dashboard-checks.json"
    if [[ $(config_value '.publicDashboards') == true ]]; then
        http_check "$WORKDIR/dashboard-checks.json" argocd "https://argocd.$domain/api/version" '(.Version // .version | type)=="string"'
        http_check "$WORKDIR/dashboard-checks.json" grafana "https://grafana.$domain/api/health" '.database=="ok"'
    fi
    jq --slurpfile native "$WORKDIR/native-checks.json" --slurpfile ui "$WORKDIR/ui-checks.json" \
        --slurpfile dashboards "$WORKDIR/dashboard-checks.json" --slurpfile c "$CONFIG" '
        .native=$native[0] | .ui.checks=$ui[0] | .credentialLifecycle="not-tested" |
        if $c[0].publicDashboards then .dashboards={public:true,checks:$dashboards[0]} else . end |
        .internetVerified=([$native[0][],$ui[0][],$dashboards[0][]]|all(.ok)) |
        .status=(if .clusterReady and .certificateReady and .gatewayConfigurationReady and .internetVerified and $ui[0][0].nativeReady
                 then "ready" else "action-required" end) |
        if .internetVerified then .dns.instructions="Public endpoints verified reachable. No DNS change is required." else . end
    ' "$WORKDIR/inspection.json"
}

api_auth_checks() {
    local tenant=$1 collection=$2
    printf '{}\n' >"$WORKDIR/probe-body.json"
    local method endpoint name
    while IFS=$'\t' read -r method endpoint name; do
        http_json "$WORKDIR/check-response.json" "$method" "$tenant/orce/ui-api/v1/$endpoint" "$WORKDIR/probe-body.json"
        jq --arg name "$name" '{name:$name,httpStatus:.status,ok:(.status==401 and (try (.data.error.code=="AUTHENTICATION_REQUIRED") catch false))}' \
            "$WORKDIR/check-response.json" >"$WORKDIR/check.json"
        jq --slurpfile check "$WORKDIR/check.json" '.+[$check[0]]' "$collection" >"$WORKDIR/ui-checks-next.json"
        mv "$WORKDIR/ui-checks-next.json" "$collection"
    done <<'PROBES'
POST	issuance	ui-post-auth
PATCH	preferences	ui-patch-auth
DELETE	credentials/esb-auth-probe	ui-delete-auth
PROBES
}

wait_validation() {
    local started=$SECONDS budget=$((TIMEOUT_SECONDS<300 ? TIMEOUT_SECONDS : 300))
    while true; do
        validate_stack >"$WORKDIR/validation.json"
        emit "$(jq -c --argjson elapsed "$((SECONDS-started))" '{type:"validation-progress",phase:"native-validation",
            elapsedSeconds:$elapsed,status,internetVerified,dependencies:(.ui.checks[0].dependencies // [])}' "$WORKDIR/validation.json")"
        if jq -e '.status=="ready" or any(.ui.checks[0].dependencies[]?;.ok==false and .httpStatus>=400 and .httpStatus<500)' \
            "$WORKDIR/validation.json" >/dev/null || ((SECONDS-started >= budget)); then
            cat "$WORKDIR/validation.json"
            return
        fi
        sleep 5
    done
}

storage_diagnostics() {
    kube_json "$WORKDIR/storage-pods.json" -n ocm-wstack get pods -o json || return 1
    run_capture "$WORKDIR/storage-diagnostics.json" 45 kubectl -n ocm-wstack exec deployment/ocm-orce -c orce -- node -e '
        const http=require("node:http");
        const req=http.get("http://127.0.0.1:1880/_ocm/storage-diagnostics",res=>{
            if(res.statusCode!==200){res.resume();process.exitCode=1;return;}
            res.pipe(process.stdout);
        });
        req.setTimeout(40000,()=>req.destroy());
        req.on("error",()=>{process.stderr.write("STORAGE_DIAGNOSTIC_FAILED\n");process.exitCode=1;});' || return 1
    jq -e 'type=="object"' "$WORKDIR/storage-diagnostics.json" >/dev/null || return 1
    jq --slurpfile pods "$WORKDIR/storage-pods.json" '.+{images:[$pods[0].items[] |
        select((.metadata.name|startswith("storage-service-")) and .metadata.deletionTimestamp==null) |
        {pod:.metadata.name,containers:[.status.containerStatuses[]? | {name,image,imageID,ready}]}]}' "$WORKDIR/storage-diagnostics.json"
}

start_tunnel() {
    local service=$1 output=$2 deadline=$((SECONDS+30)) pid port
    kubectl -n ocm-wstack port-forward "service/$service" :8080 --address=127.0.0.1 \
        >"$WORKDIR/tunnel-$service.log" 2>"$WORKDIR/tunnel-$service.error" &
    pid=$!
    TUNNEL_PIDS+=("$pid")
    while ((SECONDS < deadline)); do
        kill -0 "$pid" 2>/dev/null || { fail PORT_FORWARD "Port-forward for $service exited."; return 1; }
        port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\) -> 8080$/\1/p' "$WORKDIR/tunnel-$service.log" | head -n 1)
        if [[ $port =~ ^[0-9]+$ ]]; then printf 'http://127.0.0.1:%s\n' "$port" >"$output"; return; fi
        sleep 1
    done
    fail PORT_FORWARD "Port-forward for $service timed out."
}

record_native_check() {
    local name=$1 predicate=$2
    jq --arg name "$name" ". as \$response |
        (.data | if type==\"object\" then .message else null end) as \$message |
        {name:\$name,httpStatus:.status,ok:(.ok and (try ($predicate) catch false))} +
        (if \$message|IN(\"Region Id Missing.\",\"Country Id Missing.\",\"Tenant Id Missing.\",\"Account Id Missing.\")
         then {reason:\$message} else {} end)" "$WORKDIR/native-response.json" >"$WORKDIR/native-check.json" || return 1
    emit "$(jq -c '.+{type:"check"}' "$WORKDIR/native-check.json")" || return 1
    jq --slurpfile check "$WORKDIR/native-check.json" '.checks+=[$check[0]]' "$WORKDIR/native-report.json" >"$WORKDIR/native-report-next.json" || return 1
    mv "$WORKDIR/native-report-next.json" "$WORKDIR/native-report.json"
    jq -e '.ok' "$WORKDIR/native-check.json" >/dev/null
}

issued_credentials() {
    jq '[.data | .. | strings | select(contains("~") or test("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"))]' "$1"
}

test_credentials() {
    [[ $CONFIRM == 'CREATE TEST CREDENTIAL' ]] ||
        { fail CONFIRM 'Set confirm to CREATE TEST CREDENTIAL to run the native credential lifecycle test.'; return 1; }
    discover_storage_scope
    start_tunnel credential-retrieval-service "$WORKDIR/retrieval-url"
    start_tunnel storage-service "$WORKDIR/storage-url"
    local random group tenant retrieval storage request_id deadline found=false
    random=$(openssl rand -hex 16)
    group="esb-check-${random:0:8}-${random:8:4}-${random:12:4}-${random:16:4}-${random:20:12}"
    tenant=$(config_value '.tenantUrl')
    retrieval="$(cat "$WORKDIR/retrieval-url")/v1/tenants/$(jq -r '.tenantId|@uri' "$CONFIG")/offering"
    storage="$(cat "$WORKDIR/storage-url")$(jq -r --arg group "$group" \
        '"/v1/tenants/"+([.tenantId,"storage",.storageRegion,.storageCountry,$group,"credentials"]|map(@uri)|join("/"))' "$CONFIG")"
    jq --arg group "$group" '{status:"failed",tenantId,tenantUrl,testAccount:$group,checks:[],credentialLifecycle:"not-tested",retainedTestData:true}' \
        "$CONFIG" >"$WORKDIR/native-report.json"
    printf '{}\n' >"$WORKDIR/native-body.json"
    http_json "$WORKDIR/native-response.json" POST "$storage" "$WORKDIR/native-body.json"
    record_native_check storage-list-before true || true
    jq '{tenant_id:.tenantId,identifier:"SDJWTCredential",payload:{given_name:"Ada",family_name:"Lovelace"}}' "$CONFIG" >"$WORKDIR/native-body.json"
    http_json "$WORKDIR/native-response.json" POST "$tenant/test/offering/create" "$WORKDIR/native-body.json"
    if ! record_native_check native-offer-create '.data.offer.credential_offer|type=="string" and length>0'; then cat "$WORKDIR/native-report.json"; return; fi
    jq '{credential_offer:.data.offer.credential_offer}' "$WORKDIR/native-response.json" >"$WORKDIR/native-body.json"
    http_json "$WORKDIR/native-response.json" PUT "$retrieval/retrieve/$group" "$WORKDIR/native-body.json"
    if ! record_native_check retrieval-intake '.data|type=="string" and test("^[a-fA-F0-9-]{36}$")'; then cat "$WORKDIR/native-report.json"; return; fi
    request_id=$(jq -r '.data' "$WORKDIR/native-response.json")
    jq --arg id "$request_id" '.requestId=$id' "$WORKDIR/native-report.json" >"$WORKDIR/native-report-next.json"
    mv "$WORKDIR/native-report-next.json" "$WORKDIR/native-report.json"
    http_json "$WORKDIR/native-response.json" GET "$retrieval/list/$group"
    if ! record_native_check retrieval-list "(.data|type)==\"array\" and any(.data[]?;.requestId==\"$request_id\")"; then cat "$WORKDIR/native-report.json"; return; fi
    jq '{accept:true,holderNamespace:"ocm-wstack",holderGroup:.tenantId,holderKey:"eckey"}' "$CONFIG" >"$WORKDIR/native-body.json"
    http_json "$WORKDIR/native-response.json" DELETE "$retrieval/clear/$group/$request_id" "$WORKDIR/native-body.json" 120
    issued_credentials "$WORKDIR/native-response.json" >"$WORKDIR/issued.json"
    if ! record_native_check retrieval-acceptance "$(jq 'length>0' "$WORKDIR/issued.json")"; then cat "$WORKDIR/native-report.json"; return; fi
    deadline=$((SECONDS+90))
    printf '{}\n' >"$WORKDIR/native-body.json"
    while true; do
        http_json "$WORKDIR/native-response.json" POST "$storage" "$WORKDIR/native-body.json"
        issued_credentials "$WORKDIR/native-response.json" >"$WORKDIR/stored.json"
        if jq -e --slurpfile issued "$WORKDIR/issued.json" --slurpfile stored "$WORKDIR/stored.json" \
            '.ok and any($issued[0][];. as $credential|$stored[0]|index($credential)!=null)' "$WORKDIR/native-response.json" >/dev/null; then found=true; break; fi
        if ! jq -e '.ok' "$WORKDIR/native-response.json" >/dev/null || ((SECONDS>=deadline)); then break; fi
        sleep 2
    done
    record_native_check storage-read-back "$found" || true
    jq --argjson found "$found" --slurpfile issued "$WORKDIR/issued.json" \
        '.status=(if all(.checks[];.ok) then "passed" else "failed" end) |
         .credentialLifecycle=(if $found then "retrieved-and-read-back" else "retrieved-storage-unverified" end) |
         .credentialCount=($issued[0]|length)' "$WORKDIR/native-report.json"
}
