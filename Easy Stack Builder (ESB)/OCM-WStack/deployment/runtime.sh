#!/usr/bin/env bash
# ORCE runtime and dashboard installation. User data and retained keys stay in
# their existing Secrets and volumes when an interrupted deployment is resumed.

credential_file() {
    local name=$1 output=$2
    jq -e --arg name "$name" '.[$name] | type=="string" and length>0 and .!="__PWRD__"' "$CREDENTIALS" >/dev/null ||
        { fail CREDENTIALS "Upload or supply $name."; return 1; }
    if jq -e --arg name "$name" '.[$name]|startswith("base64:")' "$CREDENTIALS" >/dev/null; then
        jq -jr --arg name "$name" '.[$name][7:]' "$CREDENTIALS" | base64 -d >"$output" ||
            { fail CREDENTIALS "Invalid base64 transport for $name."; return 1; }
    else
        jq -jr --arg name "$name" '.[$name]' "$CREDENTIALS" >"$output"
    fi
    [[ -s $output ]] || fail CREDENTIALS "$name is empty."
}

mongo_ports() {
    jq -e '
        capture("^(?<scheme>mongodb(?:\\+srv)?)://(?<authority>[^/?]+)(?:/[^?]*)?(?:\\?.*)?$") as $uri |
        ($uri.authority | split("@") | last | split(",")) as $hosts |
        if $uri.scheme=="mongodb+srv" and ($hosts|length)!=1 then error("MongoDB SRV requires one host.") else . end |
        [$hosts[] | capture("^(?<host>\\[[0-9a-fA-F:]+\\]|[A-Za-z0-9.-]+)(?::(?<port>[0-9]+))?$") |
            if $uri.scheme=="mongodb+srv" and .port!=null then error("MongoDB SRV cannot specify a port.") else . end |
            (.port // "27017" | tonumber) |
            if .<1 or .>65535 then error("Invalid MongoDB port.") else . end] |
        if length==0 then error("Invalid MongoDB URI.") else unique end'
}

runtime_preflight() {
    local image
    image=$(config_value '.runtimeImage')
    [[ -n $image ]] ||
        { fail RUNTIME_IMAGE_REQUIRED 'Select an ORCE base image.'; return 1; }
    get_optional "$WORKDIR/runtime-secret.json" ocm-wstack secret ocm-orce-runtime
    if jq -e '.!=null' "$WORKDIR/runtime-secret.json" >/dev/null; then
        jq -r '.data["secrets.json"]' "$WORKDIR/runtime-secret.json" | base64 -d >"$WORKDIR/runtime-secrets.json"
        if ! jq -e --slurpfile c "$CONFIG" '
            . as $s |
            all(["editorHash","editorUsername","credentialSecret","offerKey","mongoPassword","mongoUri","uiAdminHash"][]; $s[.] | type=="string" and length>0) and
            .editorUsername==$c[0].editorUsername and
            ((.mongoUri|contains("@ocm-ui-mongodb.")) != $c[0].useExternalMongo) and
            (.tenantId==null or .tenantId==$c[0].tenantId) and (.tenantHost==null or .tenantHost==$c[0].tenantHost)
        ' "$WORKDIR/runtime-secrets.json" >/dev/null; then
            fail RUNTIME_SECRET 'Retained runtime Secret is incomplete or belongs to a different tenant or MongoDB topology.'
            return 1
        fi
    else
        local name
        for name in editorPassword uiAdminPassword; do
            jq -e --arg name "$name" '.[$name] | type=="string" and length>=12 and utf8bytelength<=72 and (test("[\\x00-\\x1f\\x7f]")|not)' \
                "$CREDENTIALS" >/dev/null || { fail RUNTIME_CREDENTIALS 'Initial editor and UI passwords require 12 or more characters and at most 72 UTF-8 bytes.'; return 1; }
        done
        if [[ $(config_value '.useExternalMongo') == true ]]; then
            jq '.mongoUri' "$CREDENTIALS" | mongo_ports >"$WORKDIR/mongo-ports.json" ||
                { fail RUNTIME_CREDENTIALS 'Supply a valid external MongoDB URI.'; return 1; }
        fi
    fi
    if [[ $(config_value '.publicDashboards') == true ]]; then
        get_optional "$WORKDIR/dashboard-marker.json" infrastructure configmap esb-dashboard-access
        jq -e '.==null or .metadata.labels["app.kubernetes.io/managed-by"]=="esb-ocmwstack"' "$WORKDIR/dashboard-marker.json" >/dev/null ||
            { fail OWNERSHIP 'The dashboard initialization marker belongs to another installation.'; return 1; }
        if ! jq -e '.data.initialized=="true"' "$WORKDIR/dashboard-marker.json" >/dev/null; then
            jq -e '.editorPassword | type=="string" and length>=12 and utf8bytelength<=72' "$CREDENTIALS" >/dev/null ||
                { fail DASHBOARD_CREDENTIALS 'Provide the initial editor password to initialize dashboard access.'; return 1; }
        fi
    fi
}

password_hash() {
    local name=$1 output=$2
    jq -jr --arg name "$name" '.[$name]' "$CREDENTIALS" | node "$ROOT/ocmwstack.js" --hash-password >"$output"
}

runtime_install() {
    phase orce-ui
    runtime_preflight
    discover_storage_scope
    write_values
    kube_json "$WORKDIR/runtime-services.json" -n ocm-wstack get services -o json
    jq -n --slurpfile services "$WORKDIR/runtime-services.json" '
        {storage:["storage-service",8080],retrieval:["credential-retrieval-service",8080],signer:["signer",8080],
         status:["status-list-service",8080],didcomm:["didcomm-connector",9090]} |
        to_entries | map(. as $wanted |
            [$services[0].items[] | select(.metadata.name==$wanted.value[0])][0] as $exact |
            [$services[0].items[] | select(.metadata.labels["app.kubernetes.io/name"]==$wanted.value[0])] as $matching |
            ($exact // (if $matching|length==1 then $matching[0] else null end)) as $service |
            [$service.spec.ports[]? | select(.protocol==null or .protocol=="TCP")] as $ports |
            (([$ports[]|select(.name=="http")][0]) // ([$ports[]|select(.port==$wanted.value[1])][0]) //
                (if $ports|length==1 then $ports[0] else null end)) as $port |
            select($service!=null and $port!=null) |
            {key:$wanted.key,value:("http://"+$service.metadata.name+".ocm-wstack.svc.cluster.local:"+($port.port|tostring))}) | from_entries' \
        >"$WORKDIR/runtime-discovered.json"
    jq --slurpfile services "$WORKDIR/runtime-discovered.json" --slurpfile c "$CONFIG" \
        '.services += ($services[0]+($c[0].runtimeServices|del(.issuerBootstrap)))' \
        "$WORKDIR/runtime-config.json" >"$WORKDIR/runtime-config-next.json"
    mv "$WORKDIR/runtime-config-next.json" "$WORKDIR/runtime-config.json"
    emit "$(jq -cn --slurpfile services "$WORKDIR/runtime-discovered.json" '{type:"runtime-upstreams",services:$services[0]}')"
    if ! jq -e '.!=null' "$WORKDIR/runtime-secret.json" >/dev/null; then
        password_hash editorPassword "$WORKDIR/editor-hash"
        password_hash uiAdminPassword "$WORKDIR/ui-hash"
        openssl rand -hex 32 >"$WORKDIR/credential-key"
        openssl rand -hex 32 >"$WORKDIR/application-key"
        openssl rand -hex 32 >"$WORKDIR/mongo-password"
        jq -n --slurpfile c "$CONFIG" --slurpfile credentials "$CREDENTIALS" \
            --rawfile editor "$WORKDIR/editor-hash" --rawfile ui "$WORKDIR/ui-hash" \
            --rawfile credential "$WORKDIR/credential-key" --rawfile application "$WORKDIR/application-key" \
            --rawfile mongo "$WORKDIR/mongo-password" '
            {tenantId:$c[0].tenantId,tenantHost:$c[0].tenantHost,editorUsername:$c[0].editorUsername,
             editorHash:$editor,uiAdminHash:$ui,credentialSecret:($credential|rtrimstr("\n")),
             offerKey:($application|rtrimstr("\n")),mongoPassword:($mongo|rtrimstr("\n"))} |
            .mongoUri=(if $c[0].useExternalMongo then $credentials[0].mongoUri else
              "mongodb://ocm_ui:"+.mongoPassword+"@ocm-ui-mongodb.ocm-wstack.svc.cluster.local:27017/ocm_ui?authSource=admin" end)' >"$WORKDIR/runtime-secrets.json"
        jq '{apiVersion:"v1",kind:"Secret",metadata:{name:"ocm-orce-runtime",namespace:"ocm-wstack"},type:"Opaque",
             stringData:{"secrets.json":(.|tojson),"mongo-password":.mongoPassword}}' "$WORKDIR/runtime-secrets.json" >"$WORKDIR/runtime-secret-new.json"
        run 30 kubectl create -f "$WORKDIR/runtime-secret-new.json"
    fi
    gateway_ports >"$WORKDIR/runtime-ports.json"
    local hash
    hash=$(jq -cj '.' "$WORKDIR/runtime-secrets.json" | sha256sum | cut -d ' ' -f 1)
    jq '.mongoUri' "$WORKDIR/runtime-secrets.json" | mongo_ports >"$WORKDIR/mongo-ports.json"
    jq --slurpfile runtime "$WORKDIR/runtime-config.json" --slurpfile gateway "$WORKDIR/gateway-service.json" \
        --slurpfile ports "$WORKDIR/runtime-ports.json" --slurpfile mongo "$WORKDIR/mongo-ports.json" --arg hash "$hash" '
        {host:.tenantHost,image:.runtimeImage,secretChecksum:$hash,
         hostAliases:[{ip:$gateway[0].spec.clusterIP,hostnames:[.tenantHost]}],gatewayPorts:$ports[0],
         listenerSetName:(.tenantRelease+"-xfsc-tenant-gateway"),
         storage:{orceSize:.orceStorageSize,mongoSize:.mongoStorageSize,class:.actualStorageClass},
         mongo:{embedded:(.useExternalMongo|not),externalPorts:$mongo[0]},runtimeConfig:$runtime[0]}' "$CONFIG" >"$WORKDIR/runtime-values.json"
    helm_upgrade ocm-wstack ocm-orce-ui upgrade --install ocm-orce-ui "$ROOT/charts-runtime" \
        -n ocm-wstack -f "$WORKDIR/runtime-values.json" --wait --timeout "${TIMEOUT_SECONDS}s"
    run "$((TIMEOUT_SECONDS+30))" kubectl -n ocm-wstack rollout status deployment/ocm-orce "--timeout=${TIMEOUT_SECONDS}s"
    jq '{enabled:true,url:(.tenantUrl+"/orce/"),editorUrl:(.tenantUrl+"/orce/editor/"),authentication:"mongodb-24h-session"}' \
        "$CONFIG" >"$WORKDIR/runtime-result.json"
}

dashboard_admins() {
    get_optional "$WORKDIR/dashboard-marker.json" infrastructure configmap esb-dashboard-access
    jq -e '.data.initialized=="true"' "$WORKDIR/dashboard-marker.json" >/dev/null && return 0
    password_hash editorPassword "$WORKDIR/dashboard-admin-hash"
    jq -n --rawfile hash "$WORKDIR/dashboard-admin-hash" --arg now "$(timestamp)" \
        '{stringData:{"admin.password":$hash,"admin.passwordMtime":$now}}' >"$WORKDIR/dashboard-secret-patch.json"
    run 30 kubectl -n argocd patch secret argocd-secret --type=merge --patch-file "$WORKDIR/dashboard-secret-patch.json"
    kube_json "$WORKDIR/grafana-deployments.json" -n observability get deployments \
        -l app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability -o json
    jq -e '.items|length==1' "$WORKDIR/grafana-deployments.json" >/dev/null ||
        { fail DASHBOARD_DISCOVERY 'Expected one Grafana deployment.'; return 1; }
    jq '.items[0]' "$WORKDIR/grafana-deployments.json" >"$WORKDIR/grafana-deployment.json"
    jq '[.spec.template.spec.containers[] | select(.name=="grafana") | .env[]? | select(.name=="GF_SECURITY_ADMIN_PASSWORD")][0].valueFrom.secretKeyRef' \
        "$WORKDIR/grafana-deployment.json" >"$WORKDIR/grafana-password-ref.json"
    if jq -e '.name!=null and .key!=null' "$WORKDIR/grafana-password-ref.json" >/dev/null; then
        jq --slurpfile credentials "$CREDENTIALS" '{stringData:{(.key):$credentials[0].editorPassword}}' \
            "$WORKDIR/grafana-password-ref.json" >"$WORKDIR/grafana-password-patch.json"
        run 30 kubectl -n observability patch secret "$(jq -r '.name' "$WORKDIR/grafana-password-ref.json")" \
            --type=merge --patch-file "$WORKDIR/grafana-password-patch.json"
    fi
    jq -r '.editorPassword' "$CREDENTIALS" >"$WORKDIR/dashboard-password"
    run 120 kubectl -n observability exec -i "deployment/$(jq -r '.metadata.name' "$WORKDIR/grafana-deployment.json")" \
        -c grafana -- grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini \
        admin reset-admin-password --password-from-stdin <"$WORKDIR/dashboard-password"
    jq -n '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"esb-dashboard-access",namespace:"infrastructure",
        labels:{"app.kubernetes.io/managed-by":"esb-ocmwstack"}},data:{initialized:"true",username:"admin"}}' >"$WORKDIR/dashboard-marker-new.json"
    apply_json "$WORKDIR/dashboard-marker-new.json"
}

dashboard_install() {
    phase dashboard-access
    if [[ $(config_value '.publicDashboards') != true ]]; then
        run_capture "$WORKDIR/dashboard-releases.json" 30 helm list -n infrastructure -a --filter '^esb-dashboard-routes$' -o json
        if jq -e 'length>0' "$WORKDIR/dashboard-releases.json" >/dev/null; then
            run "$((TIMEOUT_SECONDS+30))" helm uninstall esb-dashboard-routes -n infrastructure --timeout "${TIMEOUT_SECONDS}s"
        fi
        printf '{"public":false}\n' >"$WORKDIR/dashboard-result.json"
        return
    fi
    kube_json "$WORKDIR/grafana-services.json" -n observability get services \
        -l app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability -o json
    jq -e '.items|length==1' "$WORKDIR/grafana-services.json" >/dev/null ||
        { fail DASHBOARD_DISCOVERY 'Expected one Grafana Service.'; return 1; }
    get_optional "$WORKDIR/argo-service.json" argocd service argocd-server
    jq -e 'any(.spec.ports[]?; .port==80)' "$WORKDIR/argo-service.json" >/dev/null ||
        { fail DASHBOARD_DISCOVERY 'Argo CD HTTP Service port is unavailable.'; return 1; }
    get_optional "$WORKDIR/argo-params.json" argocd configmap argocd-cmd-params-cm
    if ! jq -e '.data["server.insecure"]=="true"' "$WORKDIR/argo-params.json" >/dev/null; then
        run 30 kubectl -n argocd patch configmap argocd-cmd-params-cm --type=merge -p '{"data":{"server.insecure":"true"}}'
        run 30 kubectl -n argocd rollout restart deployment/argocd-server
        run "$((TIMEOUT_SECONDS+30))" kubectl -n argocd rollout status deployment/argocd-server "--timeout=${TIMEOUT_SECONDS}s"
    fi
    dashboard_admins
    tls_install argocd
    tls_install observability
    jq --slurpfile services "$WORKDIR/grafana-services.json" '
        $services[0].items[0] as $grafana |
        (([$grafana.spec.ports[]|select(.name=="http-web")][0]) // ([$grafana.spec.ports[]|select(.port==80)][0]) // $grafana.spec.ports[0]) as $port |
        {tlsSecret:("esb-"+.tenantRelease+"-tls"),services:[
          {name:"argocd",namespace:"argocd",host:("argocd."+.domain),service:"argocd-server",port:80},
          {name:"grafana",namespace:"observability",host:("grafana."+.domain),service:$grafana.metadata.name,port:$port.port}]}' \
        "$CONFIG" >"$WORKDIR/dashboard-values.json"
    helm_upgrade infrastructure esb-dashboard-routes upgrade --install esb-dashboard-routes "$ROOT/charts-dashboards" \
        -n infrastructure -f "$WORKDIR/dashboard-values.json" --timeout "${TIMEOUT_SECONDS}s"
    run "$((TIMEOUT_SECONDS+30))" kubectl -n argocd wait --for=condition=Programmed listenerset/esb-argocd "--timeout=${TIMEOUT_SECONDS}s"
    run "$((TIMEOUT_SECONDS+30))" kubectl -n observability wait --for=condition=Programmed listenerset/esb-grafana "--timeout=${TIMEOUT_SECONDS}s"
    jq '{public:true,username:"admin",argocd:("https://argocd."+.domain),grafana:("https://grafana."+.domain)}' "$CONFIG" >"$WORKDIR/dashboard-result.json"
}
