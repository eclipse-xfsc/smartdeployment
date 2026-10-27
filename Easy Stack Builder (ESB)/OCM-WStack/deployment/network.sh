#!/usr/bin/env bash
# Uploaded certificates, Envoy routing and public DNS checks.

GATEWAY_SELECTOR='gateway.envoyproxy.io/owning-gateway-name=envoy-gateway,gateway.envoyproxy.io/owning-gateway-namespace=infrastructure'

tls_secret_name() {
    printf 'esb-%s-tls\n' "$(config_value '.tenantRelease')"
}

tls_preflight() {
    credential_file tlsCertificate "$WORKDIR/fullchain.pem"
    credential_file tlsPrivateKey "$WORKDIR/private-key.pem"
    tls_validate "$WORKDIR/fullchain.pem" "$WORKDIR/private-key.pem" "$(config_value '.tenantHost')"
    if [[ $(config_value '.publicDashboards') == true ]]; then
        tls_validate "$WORKDIR/fullchain.pem" "$WORKDIR/private-key.pem" "argocd.$(config_value '.domain')"
        tls_validate "$WORKDIR/fullchain.pem" "$WORKDIR/private-key.pem" "grafana.$(config_value '.domain')"
    fi
}

tls_validate() {
    local certificate=$1 key=$2 hostname=$3
    local directory count index leaf_digest key_digest
    [[ $(wc -c <"$certificate") -le 131072 && $(wc -c <"$key") -le 131072 ]] ||
        { fail TLS_CONFIGURATION 'TLS files must be PEM files no larger than 128 KiB.'; return 1; }
    directory=$(mktemp -d "$WORKDIR/tls-check.XXXXXX")
    awk -v directory="$directory" '
        /-----BEGIN CERTIFICATE-----/ {count++; file=directory "/cert-" count ".pem"}
        file != "" {print > file}
        /-----END CERTIFICATE-----/ {close(file); file=""}
        END {print count+0 > directory "/count"}
    ' "$certificate"
    count=$(cat "$directory/count")
    ((count > 0)) || { fail TLS_CONFIGURATION 'The uploaded file contains no PEM certificate.'; return 1; }
    run_capture "$directory/public-key.pem" 10 openssl x509 -in "$directory/cert-1.pem" -pubkey -noout ||
        { fail TLS_CONFIGURATION 'Invalid leaf certificate.'; return 1; }
    run_capture "$directory/cert-public.der" 10 openssl pkey -pubin -in "$directory/public-key.pem" -outform DER || return 1
    run_capture "$directory/key-public.der" 10 openssl pkey -in "$key" -passin pass: -pubout -outform DER ||
        { fail TLS_CONFIGURATION 'Use a valid unencrypted private key.'; return 1; }
    leaf_digest=$(sha256sum "$directory/cert-public.der" | cut -d ' ' -f 1)
    key_digest=$(sha256sum "$directory/key-public.der" | cut -d ' ' -f 1)
    [[ $leaf_digest == "$key_digest" ]] || { fail TLS_KEY_MISMATCH 'The private key does not match the leaf certificate.'; return 1; }
    run_capture "$directory/san" 10 openssl x509 -in "$directory/cert-1.pem" -noout -ext subjectAltName || return 1
    if ! jq -Rse --arg host "$hostname" '
        [scan("DNS:([^,[:space:]]+)")[0] | ascii_downcase] |
        any(. == $host or (startswith("*.") and (split(".")|length) == ($host|split(".")|length) and .[2:] == ($host|split(".")[1:]|join("."))))
    ' "$directory/san" >/dev/null; then
        fail TLS_HOSTNAME "The certificate does not cover $hostname."
        return 1
    fi
    for ((index=1; index<count; index++)); do
        run_capture "$directory/constraints" 10 openssl x509 -in "$directory/cert-$((index+1)).pem" -noout -ext basicConstraints || return 1
        grep -q 'CA:TRUE' "$directory/constraints" || { fail TLS_CHAIN 'An intermediate certificate is not a CA.'; return 1; }
        run_capture "$directory/verified" 10 openssl verify -partial_chain \
            -trusted "$directory/cert-$((index+1)).pem" "$directory/cert-$index.pem" ||
            { fail TLS_CHAIN 'Upload the leaf certificate followed by its signing intermediates in order.'; return 1; }
    done
    if ! run_capture "$directory/verified" 10 openssl verify -purpose sslserver \
        -verify_hostname "$hostname" -untrusted "$certificate" "$directory/cert-1.pem"; then
        fail TLS_CHAIN 'The certificate chain must be currently valid and link to a trusted root in the container CA store.'
        return 1
    fi
}

tls_install() {
    local namespace=${1:-ocm-wstack} name
    name=$(tls_secret_name)
    get_optional "$WORKDIR/tls-old.json" "$namespace" secret "$name"
    jq -e '. == null or .metadata.labels["app.kubernetes.io/managed-by"] == "esb-ocmwstack"' \
        "$WORKDIR/tls-old.json" >/dev/null || { fail TLS_OWNERSHIP 'TLS Secret belongs to another installation.'; return 1; }
    jq -n --arg name "$name" --arg namespace "$namespace" --arg instance "$(config_value '.instanceName')" \
        --rawfile certificate "$WORKDIR/fullchain.pem" --rawfile key "$WORKDIR/private-key.pem" '
        {apiVersion:"v1",kind:"Secret",metadata:{name:$name,namespace:$namespace,
         labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack","app.kubernetes.io/instance":$instance}},
         type:"kubernetes.io/tls",data:{"tls.crt":($certificate|@base64),"tls.key":($key|@base64)}}' >"$WORKDIR/tls-new.json"
    if jq -e --slurpfile old "$WORKDIR/tls-old.json" '.data == $old[0].data and .type == $old[0].type' "$WORKDIR/tls-new.json" >/dev/null; then
        return
    fi
    run 60 kubectl apply --server-side --field-manager=esb-ocm-tls -f "$WORKDIR/tls-new.json"
    emit "$(jq -cn --arg namespace "$namespace" --arg secret "$name" --arg hostname "$(config_value '.tenantHost')" \
        '{type:"tls-installed",namespace:$namespace,secret:$secret,hostname:$hostname}')"
}

gateway_service() {
    kube_json "$WORKDIR/gateway-services.json" -n infrastructure get services -l "$GATEWAY_SELECTOR" -o json
    jq '[.items[] | select(.spec.type == "LoadBalancer" and any(.spec.ports[]; .port == 80))]' \
        "$WORKDIR/gateway-services.json" >"$WORKDIR/gateway-candidates.json"
    jq -e 'length == 1 and (.[0].spec.clusterIP | type == "string" and . != "None" and length > 0)' \
        "$WORKDIR/gateway-candidates.json" >/dev/null ||
        { fail GATEWAY_ROUTING 'Expected one Envoy LoadBalancer Service with a ClusterIP.'; return 1; }
    jq '.[0]' "$WORKDIR/gateway-candidates.json" >"$WORKDIR/gateway-service.json"
    emit "$(jq -c '{type:"public-access",gatewayAddresses:[.status.loadBalancer.ingress[]? |
        if .ip then {type:"IPAddress",value:.ip} elif .hostname then {type:"Hostname",value:.hostname} else empty end]}' \
        "$WORKDIR/gateway-service.json")"
}

gateway_ports() {
    gateway_service
    local name
    name=$(jq -r '.metadata.name' "$WORKDIR/gateway-service.json")
    printf '{"items":[]}\n' >"$WORKDIR/gateway-slices.json"
    if jq -e 'any(.spec.ports[]; .targetPort | type == "string")' "$WORKDIR/gateway-service.json" >/dev/null; then
        kube_json "$WORKDIR/gateway-slices.json" -n infrastructure get endpointslices -l "kubernetes.io/service-name=$name" -o json
        jq -e 'any(.items[].ports[]?; .port | type == "number")' "$WORKDIR/gateway-slices.json" >/dev/null ||
            { fail GATEWAY_ROUTING 'Named Envoy target ports have no EndpointSlice ports.'; return 1; }
    fi
    jq --slurpfile slices "$WORKDIR/gateway-slices.json" \
        '[.spec.ports[] | .port, (.targetPort | select(type == "number"))] + [$slices[0].items[].ports[]?.port | select(type == "number")] | unique' \
        "$WORKDIR/gateway-service.json"
}

gateway_policy() {
    cassandra_compatibility
    gateway_service
    helm_upgrade security esb-ocm-gateway upgrade --install esb-ocm-gateway "$ROOT/charts-gateway" \
        -n security --set-string "externalTrafficPolicy=$(config_value '.externalTrafficPolicy')" \
        --set-string "tenantHost=$(config_value '.tenantHost')" \
        --set-string "gatewayClusterIP=$(jq -r '.spec.clusterIP' "$WORKDIR/gateway-service.json")" \
        --timeout "${TIMEOUT_SECONDS}s"
    local policy
    for policy in tenant-routing envoy-traffic didcomm-startup retrieval-startup; do
        wait_resource_condition "clusterpolicy/esb-ocm-$policy" Ready "$TIMEOUT_SECONDS"
    done
}

gateway_reconcile() {
    local policy
    policy=$(config_value '.externalTrafficPolicy')
    kube_json "$WORKDIR/envoy.json" -n infrastructure get envoyproxy envoy -o json
    jq -e '.spec.provider.kubernetes.envoyService | type == "object"' "$WORKDIR/envoy.json" >/dev/null ||
        { fail GATEWAY_CONFIG 'EnvoyProxy has no Kubernetes service configuration.'; return 1; }
    jq --arg policy "$policy" '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
        {op:"add",path:"/spec/provider/kubernetes/envoyService/externalTrafficPolicy",value:$policy}]' \
        "$WORKDIR/envoy.json" >"$WORKDIR/gateway-patch.json"
    run 30 kubectl -n infrastructure patch envoyproxy envoy --type=json --patch-file "$WORKDIR/gateway-patch.json"
    gateway_service
    local name
    while IFS= read -r name; do
        jq --arg name "$name" --arg policy "$policy" '.items[] | select(.metadata.name==$name) |
            [{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
             {op:"add",path:"/spec/externalTrafficPolicy",value:$policy}]' \
            "$WORKDIR/gateway-services.json" >"$WORKDIR/gateway-patch.json"
        run 30 kubectl -n infrastructure patch service "$name" --type=json --patch-file "$WORKDIR/gateway-patch.json"
    done < <(jq -r '.items[] | select(.spec.type=="LoadBalancer") | .metadata.name' "$WORKDIR/gateway-services.json")
    emit "$(jq -c --arg policy "$policy" '{type:"gateway-configured",externalTrafficPolicy:$policy,proxy:"infrastructure/envoy",services:[.items[] | select(.spec.type=="LoadBalancer") | .metadata.name]}' "$WORKDIR/gateway-services.json")"
    emit "$(jq -cn --slurpfile c "$CONFIG" --slurpfile service "$WORKDIR/gateway-service.json" \
        '{type:"dns",automatic:$c[0].externalDns,hostname:$c[0].tenantHost,targets:[$service[0].status.loadBalancer.ingress[]? | .ip // .hostname]}')"
}

native_routing() {
    gateway_service
    local namespace name kind ip hostname
    ip=$(jq -r '.spec.clusterIP' "$WORKDIR/gateway-service.json")
    hostname=$(config_value '.tenantHost')
    for namespace in ocm-wstack infrastructure; do
        kube_json "$WORKDIR/routing-workloads.json" -n "$namespace" get deployments,statefulsets -o json
        while IFS=$'\t' read -r kind name; do
            jq --arg name "$name" '.items[] | select(.metadata.name==$name)' "$WORKDIR/routing-workloads.json" >"$WORKDIR/routing-workload.json"
            json_program '(.spec.template.spec.hostAliases // []) | host_aliases($host;$ip)' \
                --arg host "$hostname" --arg ip "$ip" "$WORKDIR/routing-workload.json" >"$WORKDIR/host-aliases.json"
            if jq -e --slurpfile aliases "$WORKDIR/host-aliases.json" '.spec.template.spec.hostAliases == $aliases[0]' "$WORKDIR/routing-workload.json" >/dev/null; then
                continue
            fi
            jq --slurpfile aliases "$WORKDIR/host-aliases.json" \
                '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
                  {op:"add",path:"/spec/template/spec/hostAliases",value:$aliases[0]}]' \
                "$WORKDIR/routing-workload.json" >"$WORKDIR/routing-patch.json"
            run 30 kubectl -n "$namespace" patch "$kind" "$name" --type=json --patch-file "$WORKDIR/routing-patch.json"
            wait_workloads "$namespace" "$kind/$name"
        done < <(jq -r --arg namespace "$namespace" '.items[] |
            select(.metadata.name | test("^ocm-(ui-|orce)") | not) |
            select($namespace != "infrastructure" or (.metadata.name | test("resolver|driver-did"))) |
            [.kind,.metadata.name] | @tsv' "$WORKDIR/routing-workloads.json")
    done
    emit "$(jq -cn --arg hostname "$hostname" --arg ip "$ip" '{type:"native-routing",hostname:$hostname,clusterIP:$ip}')"
}

wait_tenant_tls() {
    phase tenant-tls
    local started=$SECONDS name hostname ready
    name="$(config_value '.tenantRelease')-xfsc-tenant-gateway"
    hostname=$(config_value '.tenantHost')
    while ((SECONDS-started < TIMEOUT_SECONDS)); do
        gateway_service
        get_optional "$WORKDIR/listener.json" ocm-wstack listenerset "$name"
        get_optional "$WORKDIR/tenant-tls.json" ocm-wstack secret "$(tls_secret_name)"
        ready=false
        if jq -e --arg host "$hostname" --arg secret "$(tls_secret_name)" '
            any(.spec.listeners[]?; .hostname==$host and any(.tls.certificateRefs[]?; .name==$secret)) and
            (.metadata.generation as $generation | any(.status.conditions[]?; .type=="Programmed" and .status=="True" and .observedGeneration==$generation))
        ' "$WORKDIR/listener.json" >/dev/null &&
           jq -e 'any(.spec.ports[]; .port==443)' "$WORKDIR/gateway-service.json" >/dev/null &&
           jq -e --slurpfile expected "$WORKDIR/tls-new.json" '.type=="kubernetes.io/tls" and .data==$expected[0].data' "$WORKDIR/tenant-tls.json" >/dev/null; then
            ready=true
        fi
        emit "$(jq -cn --arg hostname "$hostname" --argjson ready "$ready" --argjson elapsed "$((SECONDS-started))" \
            '{type:"tls-progress",phase:"tenant-tls",hostname:$hostname,ready:$ready,elapsedSeconds:$elapsed,message:(if $ready then "Tenant HTTPS is ready" else "Waiting for tenant TLS and ListenerSet" end)}')"
        [[ $ready != true ]] || return 0
        sleep 3
    done
    fail TENANT_TLS_NOT_READY 'The tenant TLS Secret, ListenerSet and Envoy HTTPS port did not become ready.'
}

permit_dns_repository() {
    [[ $(config_value '.externalDns') == true ]] || return 0
    get_optional "$WORKDIR/project.json" argocd appproject infrastructure
    if jq -e '.==null or any(.spec.sourceRepos[]?; .=="*" or .=="https://kubernetes-sigs.github.io/external-dns/")' "$WORKDIR/project.json" >/dev/null; then
        return 0
    fi
    jq -e '.metadata.annotations["meta.helm.sh/release-name"] | IN("storage","network","core")' "$WORKDIR/project.json" >/dev/null ||
        { fail OWNERSHIP 'The infrastructure AppProject has an unexpected owner.'; return 1; }
    jq '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
        {op:"add",path:"/spec/sourceRepos",value:((.spec.sourceRepos // [])+["https://kubernetes-sigs.github.io/external-dns/"])}]' \
        "$WORKDIR/project.json" >"$WORKDIR/project-patch.json"
    run 30 kubectl -n argocd patch appproject infrastructure --type=json --patch-file "$WORKDIR/project-patch.json"
}

public_dns_view() {
    local host=$1 provider=$2 output=$3 endpoint type code
    endpoint=https://dns.google/resolve
    [[ $provider != cloudflare ]] || endpoint=https://cloudflare-dns.com/dns-query
    printf '[]\n' >"$WORKDIR/dns-addresses.json"
    printf '[]\n' >"$WORKDIR/dns-errors.json"
    for type in A AAAA; do
        if run_capture "$WORKDIR/dns-response.json" 8 curl --disable --fail --silent --show-error \
            --max-time 5 --header 'Accept: application/dns-json' --get --data-urlencode "name=$host" \
            --data-urlencode "type=$type" "$endpoint" &&
            jq -e '.Status == 0 or .Status == 3' "$WORKDIR/dns-response.json" >/dev/null; then
            code=1
            [[ $type != AAAA ]] || code=28
            jq --argjson code "$code" --slurpfile old "$WORKDIR/dns-addresses.json" \
                '$old[0] + [.Answer[]? | select(.type==$code) | .data] | unique' \
                "$WORKDIR/dns-response.json" >"$WORKDIR/dns-next.json"
            mv "$WORKDIR/dns-next.json" "$WORKDIR/dns-addresses.json"
        else
            jq --arg type "$type" '. + [{type:$type,code:"DNS_LOOKUP_FAILED"}]' "$WORKDIR/dns-errors.json" >"$WORKDIR/dns-next.json"
            mv "$WORKDIR/dns-next.json" "$WORKDIR/dns-errors.json"
        fi
    done
    jq -n --arg source "$provider" --slurpfile addresses "$WORKDIR/dns-addresses.json" --slurpfile errors "$WORKDIR/dns-errors.json" \
        '{source:$source,addresses:$addresses[0],errors:$errors[0],complete:($errors[0]|length==0)}' >"$output"
}

system_dns_view() {
    local host=$1 output=$2 complete=true
    if ! run_capture "$WORKDIR/nslookup.txt" 8 busybox nslookup "$host"; then
        complete=false
    fi
    awk '/^Name:/ {answer=1} answer && /^Address[^:]*:/ {sub(/^[^:]*: +/,""); print $1}' \
        "$WORKDIR/nslookup.txt" >"$WORKDIR/system-addresses"
    jq -Rn --argjson complete "$complete" '[inputs | select(length>0)] |
        {source:"system",addresses:unique,complete:$complete,errors:(if $complete then [] else [{code:"DNS_LOOKUP_FAILED"}] end)}' \
        <"$WORKDIR/system-addresses" >"$output"
}

dns_matches() {
    json_program '($targets[0]|map(ip_key)) as $expected |
        .complete and (.addresses|length>0) and all(.addresses[]; ip_key as $ip | $expected|index($ip)!=null)' \
        -e --slurpfile targets "$WORKDIR/dns-targets.json" "$1" >/dev/null
}

wait_dns() {
    local started=$SECONDS host target ready
    jq -r '.tenantHost, (if .publicDashboards then "argocd."+.domain,"grafana."+.domain else empty end)' "$CONFIG" >"$WORKDIR/dns-hosts"
    while ((SECONDS-started < TIMEOUT_SECONDS)); do
        gateway_service
        printf '[]\n' >"$WORKDIR/dns-targets.json"
        while IFS= read -r target; do
            if [[ $target =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || $target == *:* ]]; then
                jq --arg ip "$target" '.+[$ip] | unique' "$WORKDIR/dns-targets.json" >"$WORKDIR/targets-next.json"
            else
                public_dns_view "$target" google "$WORKDIR/dns-target-view.json"
                jq --slurpfile view "$WORKDIR/dns-target-view.json" '. + (if $view[0].complete then $view[0].addresses else [] end) | unique' \
                    "$WORKDIR/dns-targets.json" >"$WORKDIR/targets-next.json"
            fi
            mv "$WORKDIR/targets-next.json" "$WORKDIR/dns-targets.json"
        done < <(jq -r '.status.loadBalancer.ingress[]? | .ip // .hostname' "$WORKDIR/gateway-service.json")
        printf '[]\n' >"$WORKDIR/dns-records.json"
        while IFS= read -r host; do
            system_dns_view "$host" "$WORKDIR/dns-system.json"
            ready=false
            if dns_matches "$WORKDIR/dns-system.json"; then
                ready=true
                jq '[.]' "$WORKDIR/dns-system.json" >"$WORKDIR/dns-views.json"
            else
                public_dns_view "$host" cloudflare "$WORKDIR/dns-cloudflare.json"
                public_dns_view "$host" google "$WORKDIR/dns-google.json"
                if dns_matches "$WORKDIR/dns-cloudflare.json" && dns_matches "$WORKDIR/dns-google.json"; then ready=true; fi
                jq -s '.' "$WORKDIR/dns-system.json" "$WORKDIR/dns-cloudflare.json" "$WORKDIR/dns-google.json" >"$WORKDIR/dns-views.json"
            fi
            jq --arg host "$host" --argjson ready "$ready" --slurpfile views "$WORKDIR/dns-views.json" \
                '. + [{hostname:$host,ready:$ready,views:$views[0],addresses:([$views[0][].addresses[]]|unique)}]' \
                "$WORKDIR/dns-records.json" >"$WORKDIR/dns-records-next.json"
            mv "$WORKDIR/dns-records-next.json" "$WORKDIR/dns-records.json"
        done <"$WORKDIR/dns-hosts"
        emit "$(jq -cn --argjson elapsed "$((SECONDS-started))" --slurpfile records "$WORKDIR/dns-records.json" \
            --slurpfile targets "$WORKDIR/dns-targets.json" '{type:"dns-progress",phase:"public-dns",elapsedSeconds:$elapsed,records:$records[0],targetIps:$targets[0]}')"
        jq -e 'length>0 and all(.[]; .ready)' "$WORKDIR/dns-records.json" >/dev/null && return 0
        sleep 10
    done
    fail DNS_NOT_READY 'DNS A and AAAA records did not converge on the current gateway addresses.'
}

# Discover DNS Services in kube-system. Requiring TCP and UDP port 53 and a
# non-empty pod selector excludes headless monitoring Services.
discover_dns() {
    local output=$1 service started=$SECONDS remaining
    kube_json "$WORKDIR/dns-services.json" -n kube-system get services -o json || return 1
    jq '[.items[] | select((.spec.selector|type)=="object" and (.spec.selector|length)>0) |
        select(any(.spec.ports[]?; .port==53 and .protocol=="UDP") and
               any(.spec.ports[]?; .port==53 and .protocol=="TCP"))]' \
        "$WORKDIR/dns-services.json" >"$WORKDIR/dns-candidates.json"
    jq -e 'length>0' "$WORKDIR/dns-candidates.json" >/dev/null ||
        { fail DNS_DISCOVERY 'No cluster DNS Service with TCP/UDP port 53 and a pod selector was found.'; return 1; }
    while ((SECONDS-started<120)); do
        printf '[]\n' >"$output"
        while IFS= read -r service; do
            remaining=$((120-(SECONDS-started)))
            ((remaining>0)) || break
            jq --arg name "$service" '.[]|select(.metadata.name==$name)' "$WORKDIR/dns-candidates.json" >"$WORKDIR/dns-service.json"
            ESB_READ_BUDGET=$remaining kube_json "$WORKDIR/dns-slices.json" -n kube-system get endpointslices.discovery.k8s.io \
                -l "kubernetes.io/service-name=$service" -o json || return 1
            if json_program 'guard_dns_egress($slices[0])' --slurpfile slices "$WORKDIR/dns-slices.json" \
                "$WORKDIR/dns-service.json" >"$WORKDIR/dns-rules.json" 2>"$WORKDIR/dns-discovery-error"; then
                jq -s '(.[0]+.[1])|unique' "$output" "$WORKDIR/dns-rules.json" >"$WORKDIR/dns-combined.json"
                mv "$WORKDIR/dns-combined.json" "$output"
            fi
        done < <(jq -r '.[].metadata.name' "$WORKDIR/dns-candidates.json")
        if jq -e 'length>0' "$output" >/dev/null; then
            emit "$(jq -cn --slurpfile rules "$output" '{type:"dns-discovery",rules:$rules[0]}')"
            return 0
        fi
        remaining=$((120-(SECONDS-started)))
        ((remaining>0)) || break
        sleep "$((remaining<3 ? remaining : 3))"
    done
    fail DNS_ENDPOINTS 'Cluster DNS Services have no usable ready endpoints after 120 seconds.'
}
