#!/usr/bin/env bash
# Native service configuration, dependency checks and guarded startup recovery.

validate_storage_scope() {
    jq -e '[.storageRegion,.storageCountry] | all(type=="string" and length>0 and .!="." and .!=".." and
        (test("[/\\\\\\x00-\\x1f]")|not))' "$CONFIG" >/dev/null ||
        fail STORAGE_SCOPE 'Native Storage geography is invalid.'
}

discover_storage_scope() {
    get_optional "$WORKDIR/retrieval-scope.json" ocm-wstack deployment credential-retrieval-service
    jq -e '[.spec.template.spec.containers[]? | select(.name=="credential-retrieval-service") | .env[]? |
        select(.name=="CREDENTIALRETRIEVAL_REGION" or .name=="CREDENTIALRETRIEVAL_COUNTRY")] | all(.[]; .valueFrom==null)' \
        "$WORKDIR/retrieval-scope.json" >/dev/null ||
        { fail STORAGE_SCOPE 'Resolve indirect Retrieval geography before configuring Storage.'; return 1; }
    update_config '([$deployment[0].spec.template.spec.containers[]? | select(.name=="credential-retrieval-service") | .env[]? |
        {key:.name,value:.value}] | from_entries) as $env |
        .storageRegion=($env.CREDENTIALRETRIEVAL_REGION // .storageRegion // "EU") |
        .storageCountry=($env.CREDENTIALRETRIEVAL_COUNTRY // .storageCountry // "DE")' --slurpfile deployment "$WORKDIR/retrieval-scope.json"
    validate_storage_scope
    emit "$(jq -c '{type:"storage-scope",storageRegion,storageCountry}' "$CONFIG")"
}

cassandra_compatibility() {
    local name=esb-ocm-cassandra-probes
    get_optional "$WORKDIR/cassandra-policy.json" '' clusterpolicy "$name"
    jq -e '.==null or (.metadata.annotations["meta.helm.sh/release-name"]=="esb-ocm-gateway" and
        .metadata.annotations["meta.helm.sh/release-namespace"]=="security")' "$WORKDIR/cassandra-policy.json" >/dev/null ||
        { fail OWNERSHIP 'Cassandra probe policy belongs to another installation.'; return 1; }
    apply_json "$ROOT/charts-gateway/templates/cassandra-probes.yaml"
    run "$((TIMEOUT_SECONDS+30))" kubectl wait "clusterpolicy/$name" --for=condition=Ready "--timeout=${TIMEOUT_SECONDS}s"
    get_optional "$WORKDIR/cassandra.json" infrastructure statefulset cassandra
    jq -e '.==null' "$WORKDIR/cassandra.json" >/dev/null && return 0
    jq -e '[.spec.template.spec.containers[]|select(.name=="cassandra")][0] |
        (.image|test("(^|/)library/cassandra:")) and
        all([.startupProbe,.readinessProbe,.livenessProbe][]; .exec.command==["/bin/bash","-ec","nodetool statusbinary | grep -q running"])' \
        "$WORKDIR/cassandra.json" >/dev/null || { fail CASSANDRA_CONTRACT 'Cassandra image or probe command differs from the configured native contract.'; return 1; }
    jq '. as $d | [.spec.template.spec.containers|to_entries[]|select(.value.name=="cassandra")][0] as $container |
        [{op:"test",path:"/metadata/resourceVersion",value:$d.metadata.resourceVersion}] +
        ["startupProbe","readinessProbe","livenessProbe" | . as $name |
         (if $container.value[$name].timeoutSeconds!=10 then
            {op:"add",path:("/spec/template/spec/containers/"+($container.key|tostring)+"/"+$name+"/timeoutSeconds"),value:10} else empty end),
         (if $name=="livenessProbe" and $container.value[$name].failureThreshold!=6 then
            {op:"add",path:("/spec/template/spec/containers/"+($container.key|tostring)+"/livenessProbe/failureThreshold"),value:6} else empty end)]' \
        "$WORKDIR/cassandra.json" >"$WORKDIR/cassandra-patch.json"
    if jq -e 'length>1' "$WORKDIR/cassandra-patch.json" >/dev/null; then
        run 30 kubectl -n infrastructure patch statefulset cassandra --type=json --patch-file "$WORKDIR/cassandra-patch.json"
        run "$((TIMEOUT_SECONDS+30))" kubectl -n infrastructure rollout status statefulset/cassandra "--timeout=${TIMEOUT_SECONDS}s"
    fi
    emit '{"type":"cassandra-probes","timeoutSeconds":10,"livenessFailureThreshold":6}'
}

resolver_preflight() {
    get_optional "$WORKDIR/resolver.json" infrastructure service universal-resolver-service
    jq -e 'any(.spec.ports[]?; .port==8080)' "$WORKDIR/resolver.json" >/dev/null ||
        fail RESOLVER_SERVICE 'The native universal-resolver-service must expose port 8080.'
}

verification_pull_secret() {
    local name=esb-ocm-public-registry
    get_optional "$WORKDIR/pull-secret.json" ocm-wstack secret "$name"
    if jq -e '.!=null' "$WORKDIR/pull-secret.json" >/dev/null; then
        jq -e '.metadata.labels["app.kubernetes.io/managed-by"]=="esb-ocmwstack" and
            .type=="kubernetes.io/dockerconfigjson" and (.data[".dockerconfigjson"]|@base64d|fromjson)=={auths:{}}' \
            "$WORKDIR/pull-secret.json" >/dev/null || { fail OWNERSHIP 'The verification registry Secret belongs to another configuration.'; return 1; }
    else
        jq -n --arg name "$name" '{apiVersion:"v1",kind:"Secret",metadata:{name:$name,namespace:"ocm-wstack",
            labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},type:"kubernetes.io/dockerconfigjson",
            stringData:{".dockerconfigjson":"{\"auths\":{}}"}}' >"$WORKDIR/pull-secret-new.json"
        run 30 kubectl create -f "$WORKDIR/pull-secret-new.json"
    fi
    get_optional "$WORKDIR/verification.json" ocm-wstack deployment credential-verification-service
    jq '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion}] +
        [.spec.template.spec.imagePullSecrets // [] | to_entries[] |
         select(.value.name==null or (.value.name|type)!="string" or (.value.name|test("^\\s*$"))) |
         {op:"remove",path:("/spec/template/spec/imagePullSecrets/"+(.key|tostring))}] | .[0:1] + (.[1:]|reverse)' \
        "$WORKDIR/verification.json" >"$WORKDIR/pull-secret-patch.json"
    if jq -e 'length>1' "$WORKDIR/pull-secret-patch.json" >/dev/null; then
        run 30 kubectl -n ocm-wstack patch deployment credential-verification-service --type=json --patch-file "$WORKDIR/pull-secret-patch.json"
    fi
}

signing_secret() {
    get_optional "$WORKDIR/signing.json" ocm-wstack secret signing
    if jq -e '.!=null' "$WORKDIR/signing.json" >/dev/null; then
        jq -er '.data.eckey // .data["signing-key"]' "$WORKDIR/signing.json" | base64 -d >"$WORKDIR/signing.pem"
        if ! grep -q -- '-----BEGIN' "$WORKDIR/signing.pem"; then
            base64 -d <"$WORKDIR/signing.pem" >"$WORKDIR/signing-decoded.pem"
            mv "$WORKDIR/signing-decoded.pem" "$WORKDIR/signing.pem"
        fi
        grep -q -- '-----BEGIN EC PRIVATE KEY-----' "$WORKDIR/signing.pem" ||
            { fail SIGNING_KEY 'The retained signing key requires the native EC PRIVATE KEY label.'; return 1; }
        sed 's/EC PRIVATE KEY/PRIVATE KEY/g' "$WORKDIR/signing.pem" >"$WORKDIR/signing-pkcs8.pem"
        # pkcs8 requires PKCS#8 contents; ec verifies the underlying algorithm.
        run_capture "$WORKDIR/signing-check.pem" 10 openssl pkcs8 -in "$WORKDIR/signing-pkcs8.pem" -nocrypt -outform PEM ||
            { fail SIGNING_KEY 'The retained signing key is not PKCS#8.'; return 1; }
        run_capture "$WORKDIR/signing-check.txt" 10 openssl ec -in "$WORKDIR/signing-check.pem" -check -noout ||
            { fail SIGNING_KEY 'The retained signing key is not a valid EC key.'; return 1; }
        if ! jq -e '.data.eckey != null' "$WORKDIR/signing.json" >/dev/null; then
            jq '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
                 {op:"add",path:"/data/eckey",value:.data["signing-key"]}]' \
                "$WORKDIR/signing.json" >"$WORKDIR/signing-patch.json"
            run 30 kubectl -n ocm-wstack patch secret signing --type=json --patch-file "$WORKDIR/signing-patch.json"
        fi
    else
        run_capture "$WORKDIR/signing-pkcs8.pem" 10 openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1
        sed 's/PRIVATE KEY/EC PRIVATE KEY/g' "$WORKDIR/signing-pkcs8.pem" >"$WORKDIR/signing.pem"
        jq -n --rawfile key "$WORKDIR/signing.pem" '{apiVersion:"v1",kind:"Secret",metadata:{name:"signing",namespace:"ocm-wstack",
            labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},type:"Opaque",stringData:{eckey:$key}}' >"$WORKDIR/signing-new.json"
        run 30 kubectl create -f "$WORKDIR/signing-new.json"
    fi
}

native_prerequisites() {
    install_reconciler
    resolver_preflight
    verification_pull_secret
    signing_secret
    local name=esb-credential-verification-cassandra
    get_optional "$WORKDIR/cassandra-secret-ref.json" ocm-wstack externalsecret "$name"
    jq -e '.==null or .metadata.labels["app.kubernetes.io/managed-by"]=="esb-ocmwstack"' \
        "$WORKDIR/cassandra-secret-ref.json" >/dev/null || { fail OWNERSHIP 'The verification ExternalSecret has another owner.'; return 1; }
    jq -n --arg name "$name" '{apiVersion:"external-secrets.io/v1",kind:"ExternalSecret",
        metadata:{name:$name,namespace:"ocm-wstack",labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},
        spec:{refreshInterval:"15m",secretStoreRef:{name:"infrastructure-openbao",kind:"ClusterSecretStore"},
        target:{name:$name,creationPolicy:"Owner",deletionPolicy:"Retain"},
        data:[{secretKey:"cassandra-password",remoteRef:{key:"cassandra/cassandra",property:"password"}}]}}' >"$WORKDIR/cassandra-secret-ref-new.json"
    apply_json "$WORKDIR/cassandra-secret-ref-new.json"
    run "$((TIMEOUT_SECONDS+15))" kubectl -n ocm-wstack wait --for=condition=Ready "externalsecret/$name" "--timeout=${TIMEOUT_SECONDS}s"
    emit '{"type":"ocm-prerequisites","cassandraSecret":"esb-credential-verification-cassandra"}'
}

discover_api_egress() {
    kube_json "$WORKDIR/api-service.json" -n default get service kubernetes -o json
    kube_json "$WORKDIR/api-slices.json" -n default get endpointslices.discovery.k8s.io -l kubernetes.io/service-name=kubernetes -o json
    printf 'null\n' >"$WORKDIR/api-endpoints.json"
    jq -L "$DEPLOYMENT" --slurpfile slices "$WORKDIR/api-slices.json" 'include "filters"; api_backends($slices[0];null)' \
        "$WORKDIR/api-service.json" >"$WORKDIR/api-backends.json"
    if jq -e 'length==0' "$WORKDIR/api-backends.json" >/dev/null; then
        kube_json "$WORKDIR/api-endpoints.json" -n default get endpoints kubernetes -o json
        jq -L "$DEPLOYMENT" --slurpfile slices "$WORKDIR/api-slices.json" --slurpfile endpoints "$WORKDIR/api-endpoints.json" \
            'include "filters"; api_backends($slices[0];$endpoints[0])' "$WORKDIR/api-service.json" >"$WORKDIR/api-backends.json"
    fi
    jq -L "$DEPLOYMENT" --slurpfile backends "$WORKDIR/api-backends.json" \
        'include "filters"; api_egress($backends[0])' "$WORKDIR/api-service.json" >"$WORKDIR/api-egress.json"
}

install_reconciler() {
    discover_api_egress
    local checksum
    checksum=$(cat "$DEPLOYMENT/reconcile.sh" "$DEPLOYMENT/filters.jq" | sha256sum | cut -d ' ' -f 1)
    jq --arg image "$(config_value '.runtimeImage')" --arg checksum "$checksum" \
        --rawfile script "$DEPLOYMENT/reconcile.sh" --rawfile filters "$DEPLOYMENT/filters.jq" --slurpfile egress "$WORKDIR/api-egress.json" '
        .items |= map(if .kind=="ConfigMap" then .data={"reconcile.sh":$script,"filters.jq":$filters}
        elif .kind=="Deployment" then .spec.template.spec.containers[0].image=$image |
            .spec.template.metadata.annotations["esb.xfsc.io/source"]=$checksum
        elif .kind=="NetworkPolicy" then .spec.egress=(.spec.egress[0:1]+$egress[0]+.spec.egress[1:]) else . end)' \
        "$DEPLOYMENT/templates/reconciler.json" >"$WORKDIR/reconciler.json"
    local kind namespace name
    while IFS=$'\t' read -r kind namespace name; do
        [[ $namespace != '-' ]] || namespace=''
        get_optional "$WORKDIR/guard-existing.json" "$namespace" "$kind" "$name"
        jq -e '.==null or .metadata.labels["app.kubernetes.io/managed-by"]=="esb-ocmwstack"' "$WORKDIR/guard-existing.json" >/dev/null ||
            { fail OWNERSHIP 'A reconciler resource belongs to another owner.'; return 1; }
    done < <(jq -r '.items[] | [.kind,(.metadata.namespace // "-"),.metadata.name] | @tsv' "$WORKDIR/reconciler.json")
    apply_json "$WORKDIR/reconciler.json"
    emit "$(jq -cn --arg image "$(config_value '.runtimeImage')" '{type:"ocm-guard",state:"installed",image:$image}')"
}

guard_status() {
    if ! run_capture "$WORKDIR/guard-response.json" 20 kubectl get --raw=/api/v1/namespaces/ocm-wstack/services/http:esb-ocm-guard:8080/proxy/status; then
        printf '{"ready":false,"code":"GUARD_UNREACHABLE"}\n' >"$WORKDIR/guard-status.json"
        return 0
    fi
    if ! jq -e 'type=="object" and (.ready|type)=="boolean"' "$WORKDIR/guard-response.json" >/dev/null; then
        printf '{"ready":false,"code":"GUARD_INVALID_RESPONSE"}\n' >"$WORKDIR/guard-status.json"
        return 0
    fi
    kube_json "$WORKDIR/guard-deployments.json" -n ocm-wstack get deployments -o json
    kube_json "$WORKDIR/guard-pods.json" -n ocm-wstack get pods -o json
    kube_json "$WORKDIR/guard-replicasets.json" -n ocm-wstack get replicasets -o json
    jq -L "$DEPLOYMENT" --slurpfile deployments "$WORKDIR/guard-deployments.json" \
        --slurpfile pods "$WORKDIR/guard-pods.json" --slurpfile replicasets "$WORKDIR/guard-replicasets.json" --argjson now "$(date +%s)" '
        include "filters"; validate_guard_status($deployments[0].items;$pods[0].items;$replicasets[0].items;$now)' \
        "$WORKDIR/guard-response.json" >"$WORKDIR/guard-status.json"
}

save_recovery_evidence() {
    get_optional "$WORKDIR/recovery-marker.json" ocm-wstack configmap esb-retrieval-migration-recovery
    jq -e '.==null or .metadata.labels["app.kubernetes.io/managed-by"]=="esb-ocmwstack"' "$WORKDIR/recovery-marker.json" >/dev/null ||
        { fail OWNERSHIP 'Retrieval recovery evidence belongs to another owner.'; return 1; }
    jq '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"esb-retrieval-migration-recovery",namespace:"ocm-wstack",
        labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},data:{"recovery.json":(.|tojson)}}' \
        "$WORKDIR/recovery-evidence.json" >"$WORKDIR/recovery-marker-new.json"
    apply_json "$WORKDIR/recovery-marker-new.json"
}

retrieval_recovery_contract() {
    jq -L "$DEPLOYMENT" --slurpfile pods "$WORKDIR/retrieval-pods.json" \
        'include "filters"; retrieval_recovery_contract($pods[0])' "$WORKDIR/retrieval-deployment.json"
}

repair_retrieval() {
    retrieval_recovery_contract >"$WORKDIR/recovery-contract.json"
    jq -e '.==null' "$WORKDIR/recovery-contract.json" >/dev/null && return 0
    local secret pod checksum
    secret=$(jq -r '.secret' "$WORKDIR/recovery-contract.json")
    kube_json "$WORKDIR/retrieval-secret.json" -n ocm-wstack get secret "$secret" -o json
    kube_json "$WORKDIR/cassandra-pods.json" -n infrastructure get pods -l app.kubernetes.io/name=cassandra -o json
    pod=$(jq -er '[.items[] | select(.metadata.deletionTimestamp==null and any(.status.containerStatuses[]?; .name=="cassandra" and .ready))][0].metadata.name // empty' "$WORKDIR/cassandra-pods.json") ||
        { fail RETRIEVAL_RECOVERY_DATABASE 'No ready Cassandra container is available.'; return 1; }
    checksum=8968c7a3719d337d84846d35aa370462e9977641cb2a876046ee82ade7bbb864
    [[ $(sha256sum "$ROOT/scripts/retrieval-v001.cql" | cut -d ' ' -f 1) == "$checksum" ]] ||
        { fail RETRIEVAL_MIGRATION_CHECKSUM 'Packaged native migration checksum changed.'; return 1; }
    jq --arg checksum "$checksum" --rawfile cql "$ROOT/scripts/retrieval-v001.cql" \
        '{username:(.data.username|@base64d),password:(.data.password|@base64d),host:"cassandra.infrastructure.svc.cluster.local",port:9042,cql:$cql,checksum:$checksum,mode:"inspect"}' \
        "$WORKDIR/retrieval-secret.json" >"$WORKDIR/recovery-input.json"
    local program
    program=$(cat "$ROOT/scripts/retrieval-recovery.py")
    if ! run_capture "$WORKDIR/recovery-inspection.json" 180 kubectl -n infrastructure exec -i "$pod" -c cassandra \
        -- python3 -c "$program" <"$WORKDIR/recovery-input.json"; then
        fail RETRIEVAL_RECOVERY 'Native migration inspection failed.'
        return 1
    fi
    jq -e '.state!="blocked" and (.state|type)=="string"' "$WORKDIR/recovery-inspection.json" >/dev/null ||
        { fail RETRIEVAL_RECOVERY 'Native migration inspection did not return a supported result.'; return 1; }
    jq -e '.state=="repairable"' "$WORKDIR/recovery-inspection.json" >/dev/null || return 0
    jq --slurpfile contract "$WORKDIR/recovery-contract.json" --arg checksum "$checksum" --arg now "$(timestamp)" \
        '.+$contract[0]+{checksum:$checksum,checkedAt:$now}|del(.secret)' "$WORKDIR/recovery-inspection.json" >"$WORKDIR/recovery-evidence.json"
    save_recovery_evidence
    kube_json "$WORKDIR/retrieval-deployment.json" -n ocm-wstack get deployment credential-retrieval-service -o json
    kube_json "$WORKDIR/retrieval-current-pods.json" -n ocm-wstack get pods -l app.kubernetes.io/name=credential-retrieval-service -o json
    jq '.items' "$WORKDIR/retrieval-current-pods.json" >"$WORKDIR/retrieval-pods.json"
    retrieval_recovery_contract >"$WORKDIR/recovery-contract-next.json"
    jq -e '.==null' "$WORKDIR/recovery-contract-next.json" >/dev/null && return 0
    jq -e --slurpfile old "$WORKDIR/recovery-contract.json" '.==$old[0]' "$WORKDIR/recovery-contract-next.json" >/dev/null ||
        { fail RETRIEVAL_RECOVERY_CONTRACT 'The Retrieval recovery contract changed during inspection.'; return 1; }
    jq --slurpfile inspection "$WORKDIR/recovery-inspection.json" '.mode="repair"|.expected=$inspection[0].before' \
        "$WORKDIR/recovery-input.json" >"$WORKDIR/recovery-repair-input.json"
    if ! run_capture "$WORKDIR/recovery-result.json" 180 kubectl -n infrastructure exec -i "$pod" -c cassandra \
        -- python3 -c "$program" <"$WORKDIR/recovery-repair-input.json"; then
        fail RETRIEVAL_RECOVERY 'Native migration recovery stopped; inspect its evidence before retrying.'
        return 1
    fi
    jq -e '.state=="repaired" or .state=="not-needed"' "$WORKDIR/recovery-result.json" >/dev/null ||
        { fail RETRIEVAL_RECOVERY 'Native migration recovery was not confirmed.'; return 1; }
    jq --slurpfile result "$WORKDIR/recovery-result.json" --arg now "$(timestamp)" '.+$result[0]+{finishedAt:$now}' \
        "$WORKDIR/recovery-evidence.json" >"$WORKDIR/recovery-evidence-next.json"
    mv "$WORKDIR/recovery-evidence-next.json" "$WORKDIR/recovery-evidence.json"
    save_recovery_evidence
    emit "$(jq -c '{type:"migration-recovery",service:"credential-retrieval",state,version:1,checksum,evidence:"ocm-wstack/esb-retrieval-migration-recovery"}' "$WORKDIR/recovery-evidence.json")"
}

native_startup() {
    local started=$SECONDS name pod dirty
    local targets=(credential-retrieval-service)
    [[ $(optional_value '.runtimeServices.didcomm') != '' ]] || targets+=(didcomm-connector)
    while ((SECONDS-started < TIMEOUT_SECONDS)); do
        kube_json "$WORKDIR/startup-deployments.json" -n ocm-wstack get deployments -o json
        jq '[.items[]|select(.metadata.name=="credential-retrieval-service")][0]' "$WORKDIR/startup-deployments.json" >"$WORKDIR/retrieval-deployment.json"
        if jq -e '.!=null and .spec.strategy.type!="Recreate"' "$WORKDIR/retrieval-deployment.json" >/dev/null; then
            jq '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},{op:"add",path:"/spec/strategy",value:{type:"Recreate"}}]' \
                "$WORKDIR/retrieval-deployment.json" >"$WORKDIR/retrieval-strategy.json"
            run 30 kubectl -n ocm-wstack patch deployment credential-retrieval-service --type=json --patch-file "$WORKDIR/retrieval-strategy.json"
            sleep 1
            continue
        fi
        jq -L "$DEPLOYMENT" --args 'include "filters"; [.items[]|select(.metadata.name as $name | $ARGS.positional|index($name)!=null)|
            {name:.metadata.name,ready:ready_workload,available:(.status.availableReplicas // 0)}]' \
            "${targets[@]}" <"$WORKDIR/startup-deployments.json" >"$WORKDIR/startup-status.json"
        if jq -e --argjson count "${#targets[@]}" 'length==$count and all(.[];.ready)' "$WORKDIR/startup-status.json" >/dev/null; then
            guard_status
            jq -e '.ready' "$WORKDIR/guard-status.json" >/dev/null && return 0
            emit "$(jq '.+{type:"ocm-guard",phase:"ocm-startup"}' "$WORKDIR/guard-status.json")"
        fi
        kube_json "$WORKDIR/startup-pods.json" -n ocm-wstack get pods -o json
        jq '[.items[] | select(.metadata.labels["app.kubernetes.io/name"]=="credential-retrieval-service")]' \
            "$WORKDIR/startup-pods.json" >"$WORKDIR/retrieval-pods.json"
        dirty=false
        while IFS= read -r pod; do
            if run_capture "$WORKDIR/retrieval-log" 20 kubectl -n ocm-wstack logs "$pod" -c credential-retrieval-service --tail=25 --previous &&
                grep -qF 'migration V001 (create offerings table) is marked dirty' "$WORKDIR/retrieval-log"; then dirty=true; fi
        done < <(jq -r '.[] | select(any(.status.containerStatuses[]?; .name=="credential-retrieval-service" and .ready!=true and .restartCount>0)) | .metadata.name' "$WORKDIR/retrieval-pods.json")
        emit "$(jq -cn --slurpfile services "$WORKDIR/startup-status.json" --argjson elapsed "$((SECONDS-started))" \
            '{type:"ocm-startup",phase:"ocm-wstack",services:$services[0],elapsedSeconds:$elapsed}')"
        [[ $dirty != true ]] || repair_retrieval
        sleep 10
    done
    fail OCM_STARTUP 'Native services and their credential/listener checks did not become ready.'
}
