#!/usr/bin/env bash
# Exact jq programs and upstream patch used by the deployment helpers.
set -Eeuo pipefail
case ${1:-} in
    filters) cat <<'OCM_FILTERS'
# JSON transformations shared by the deployer and native reconciler.
# Functions are defined in dependency order in this single module.

# Configuration, provider values and IP addresses

# Configuration and provider resolution. These functions transform JSON only.

def require_that($condition; $message):
    if $condition then . else error($message) end;

def text: (. // "") | tostring | gsub("^\\s+|\\s+$"; "");
def enabled: . == true or . == "true";
def nonempty: if . == "" or . == null then null else . end;
def object_value:
    if . == null or . == "" then {}
    elif type == "string" then fromjson
    else . end
    | require_that(type == "object"; "Expected a JSON object.");

def dns_name:
    type == "string" and length > 0 and length <= 253 and
    (split(".") | all(length <= 63 and test("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")));

def normalize_config:
    . as $input |
    {
        procedureVersion:(.procedureVersion | tonumber),
        instanceName:((.instanceName|nonempty) // "ocm-wstack"),
        domain:(((.domainAddress|nonempty) // .domain) | text | ascii_downcase | sub("^\\*\\."; "")),
        email:(((.emailAddress|nonempty) // .email) | text),
        tenantId:(((.tenantId|nonempty) // "demo-tenant") | text),
        tenantRelease:(((.tenantRelease|nonempty) // "demotenant") | text),
        tenantSubdomain:(((.tenantSubdomain | nonempty) // (.tenantId | nonempty) // "demo-tenant") | text | ascii_downcase | gsub("_"; "-")),
        provider:((.provider|nonempty) // "auto"), storageClass:(.storageClass | text),
        externalDns:(.externalDns | enabled), dnsProvider:((.dnsProvider|nonempty) // "auto"),
        dnsValues:(.dnsValues | object_value), lbAnnotations:(.lbAnnotations | object_value),
        timeoutSeconds:(((.timeoutSeconds|nonempty) // 1800) | tonumber),
        externalTrafficPolicy:((.externalTrafficPolicy|nonempty) // "Cluster"),
        gatewayRouting:"internal", internalGatewayRouting:true, tlsMode:"uploaded",
        publicDashboards:(.publicDashboards | enabled),
        lbLocation:(.lbLocation | text), lbNetworkZone:(.lbNetworkZone | text),
        lbType:(.lbType | text), lbPrivate:(.lbPrivate | enabled),
        runtimeEnabled:true, runtimeImage:((.runtimeImage | nonempty) // "ecofacis/xfsc-orce:2.0.15"),
        orceStorageSize:((.orceStorageSize|nonempty) // "3Gi"), mongoStorageSize:((.mongoStorageSize|nonempty) // "5Gi"),
        useExternalMongo:(.useExternalMongo | enabled),
        editorUsername:((.editorUsername|nonempty) // "admin"), uiAdminUsername:((.uiAdminUsername|nonempty) // "admin"),
        uiAdminEmail:((.uiAdminEmail|nonempty) // (.emailAddress|nonempty) // .email // ""),
        runtimeServices:(.runtimeServices | object_value)
    }
    | require_that(.procedureVersion == 12; "Configuration must use procedureVersion 12.")
    | require_that(.instanceName | test("^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$"); "Invalid instance name.")
    | require_that((.domain | dns_name) and (.domain | contains(".")); "Enter a bare public domain.")
    | require_that(.email == "" or (.email | test("^[^\\s@,]+@[^\\s@,]+\\.[^\\s@,]+$")); "Invalid email address.")
    | require_that(.tenantId | test("^[a-z][a-z0-9_-]{0,39}$"); "Invalid tenant ID.")
    | require_that((.tenantSubdomain | dns_name) and (.tenantSubdomain | contains(".") | not); "Invalid tenant subdomain.")
    | require_that((.tenantRelease | dns_name) and (.tenantRelease | length <= 35) and (.tenantRelease | contains(".") | not); "Invalid tenant release.")
    | require_that(.provider | IN("auto","generic","hetzner","ionos","aws","azure","gcp","openstack","digitalocean","oci","scaleway","alibaba"); "Unknown cluster provider.")
    | require_that(.dnsProvider | IN("auto","hetzner","ionos","custom"); "Unknown DNS provider.")
    | require_that(.storageClass == "" or (.storageClass | dns_name); "Invalid StorageClass name.")
    | require_that(.timeoutSeconds >= 60 and .timeoutSeconds <= 7200 and (.timeoutSeconds | floor) == .timeoutSeconds; "Timeout must be 60–7200 seconds.")
    | require_that(.externalTrafficPolicy | IN("Cluster","Local"); "Invalid traffic policy.")
    | require_that(.provider != "ionos" or .externalTrafficPolicy == "Cluster"; "IONOS requires Cluster traffic policy.")
    | require_that([.lbLocation,.lbNetworkZone,.lbType] | all(. == "" or test("^[a-z0-9/-]{1,64}$")); "Invalid load-balancer setting.")
    | require_that([.orceStorageSize,.mongoStorageSize] | all(test("^[1-9][0-9]*(Gi|Mi)$")); "PVC sizes require positive Mi or Gi quantities.")
    | require_that(.runtimeImage == "" or ((.runtimeImage | test("^[a-zA-Z0-9_./:@-]+$")) and (.runtimeImage | endswith(":latest") | not)); "Select a tagged runtime image.")
    | require_that([.editorUsername,.uiAdminUsername] | all(test("^[A-Za-z0-9_.@-]{1,64}$")); "Invalid administrator username.")
    | require_that(.runtimeServices | to_entries | all((.key | IN("storage","retrieval","signer","status","didcomm","issuerBootstrap")) and (.value | type == "string" and test("^https?://[^/@?#[:space:]]+(:[0-9]+)?(/[^?#[:space:]]*)?$"))); "Invalid native service override.")
    | require_that(.lbAnnotations | to_entries | all((.key | test("^[a-zA-Z0-9./_-]+$")) and (.value == null or (.value | type == "string"))); "Invalid load-balancer annotations.")
    | require_that((.externalDns and .dnsProvider == "custom" | not) or (.dnsValues.provider.name | type == "string"); "Custom DNS requires provider.name.")
    | .tenantHost = (.tenantSubdomain + "." + .domain)
    | require_that(.tenantHost | dns_name; "Tenant hostname exceeds DNS limits.")
    | .tenantUrl = ("https://" + .tenantHost);

def detect_provider($nodes; $classes):
    [$nodes.items[]? |
        ((.spec.providerID // "") | ascii_downcase | (split("://")[0] // "") |
          {hcloud:"hetzner",hetzner:"hetzner",ionos:"ionos",ionoscloud:"ionos","ionos-cloud":"ionos",
           aws:"aws",azure:"azure",gce:"gcp",openstack:"openstack",digitalocean:"digitalocean",
           oci:"oci",scaleway:"scaleway",alicloud:"alibaba"}[.]),
        ((.metadata.labels // {}) | keys[] |
          if startswith("ionoscloud.com/") or startswith("cloud.ionos.com/") then "ionos"
          elif startswith("hcloud.hetzner.cloud/") then "hetzner" else empty end)
    ] | map(select(. != null)) | unique as $strong |
    [$classes.items[]? | .provisioner // "" |
        if test("ionos";"i") then "ionos" elif test("csi\\.hetzner\\.cloud";"i") then "hetzner" else empty end
    ] | unique as $storage |
    (if $strong | length > 0 then $strong else $storage end) as $found |
    {provider:(if $found | length == 1 then $found[0] else "generic" end),
     evidence:(if $strong | length > 0 then "nodes" elif $storage | length > 0 then "storage-provisioner" else "unknown" end),
     mixed:($found | length > 1),
     locations:([$nodes.items[]? | .metadata.labels | .["topology.kubernetes.io/region"] // .["failure-domain.beta.kubernetes.io/region"] // empty] | unique),
     zones:([$nodes.items[]? | .metadata.labels | .["topology.kubernetes.io/zone"] // .["failure-domain.beta.kubernetes.io/zone"] // empty] | unique)};

def provider_annotations:
    if .actualProvider != "hetzner" then
        require_that(.lbAnnotations | to_entries | all((.key | startswith("load-balancer.hetzner.cloud/") | not) or .value == null); "Hetzner annotations require Hetzner.")
        | .lbAnnotations
    else
        {fsn1:"eu-central",nbg1:"eu-central",hel1:"eu-central",ash:"us-east",hil:"us-west",sin:"ap-southeast"} as $zones |
        (if .lbLocation != "" then .lbLocation elif .providerLocations | length == 1 then .providerLocations[0] else "" end) as $location |
        (if .lbNetworkZone != "" then .lbNetworkZone else
            $zones[$location] //
            (if .providerLocations | length == 1 then .providerLocations[0] | select(IN("eu-central","us-east","us-west","ap-southeast")) else empty end) //
            (if .providerZones | length == 1 then ($zones[.providerZones[0]] // (.providerZones[0] | select(IN("eu-central","us-east","us-west","ap-southeast")))) else empty end) // ""
        end) as $zone |
        require_that($zone != "" or .lbLocation != "" or .lbAnnotations["load-balancer.hetzner.cloud/location"] != null or .lbAnnotations["load-balancer.hetzner.cloud/network-zone"] != null; "Select a Hetzner location or network zone.") |
        . as $c |
        {"load-balancer.hetzner.cloud/protocol":"tcp","load-balancer.hetzner.cloud/health-check-protocol":"tcp",
         "load-balancer.hetzner.cloud/uses-proxyprotocol":"false"}
        + (if $c.lbLocation != "" and $c.lbNetworkZone == "" then {"load-balancer.hetzner.cloud/location":$c.lbLocation}
           elif $zone != "" then {"load-balancer.hetzner.cloud/network-zone":$zone} else {} end)
        + (if $c.lbType != "" then {"load-balancer.hetzner.cloud/type":$c.lbType} else {} end)
        + {"load-balancer.hetzner.cloud/use-private-ip":($c.lbPrivate|tostring),
           "load-balancer.hetzner.cloud/disable-private-ingress":($c.lbPrivate|tostring)}
        + $c.lbAnnotations
    end;

def resolve_config($nodes; $classes; $credentials):
    detect_provider($nodes;$classes) as $detected |
    .detectedProvider = $detected.provider | .providerLocations = $detected.locations |
    .providerZones = $detected.zones | .providerEvidence = $detected.evidence |
    .internalGatewayRouting = (.gatewayRouting != "public") |
    .actualProvider = (if .provider == "auto" then $detected.provider else .provider end) |
    .actualDns = (if .externalDns | not then "disabled" elif .dnsProvider != "auto" then .dnsProvider
                 elif .actualProvider | IN("hetzner","ionos") then .actualProvider else "" end) |
    require_that(.actualDns != ""; "Select the DNS hosting provider.") |
    require_that(.actualProvider != "ionos" or .externalTrafficPolicy == "Cluster"; "IONOS requires Cluster traffic policy.") |
    require_that((.actualDns | IN("hetzner","ionos") | not) or ($credentials.dnsToken | type == "string" and length > 0); "DNS API token is required.") |
    .dnsSecret = (if .actualDns == "custom" then ($credentials.dnsSecretData | object_value) else {token:($credentials.dnsToken // "")} end) |
    require_that(.dnsSecret | to_entries | all((.key | test("^[A-Za-z0-9._-]+$")) and (.value | type == "string")); "Invalid DNS Secret data.") |
    .profile = (if .actualDns | IN("hetzner","ionos") then .actualDns elif (.externalDns | not) and .actualProvider == "hetzner" then "hetzner" else "generic" end) |
    . as $c |
    (if .storageClass != "" then [$classes.items[]? | select(.metadata.name == $c.storageClass)]
     else [$classes.items[]? | select(.metadata.annotations["storageclass.kubernetes.io/is-default-class"] == "true" or .metadata.annotations["storageclass.beta.kubernetes.io/is-default-class"] == "true")] end) as $selected |
    require_that($selected | length == 1; "Select an existing unambiguous StorageClass.") |
    .actualStorageClass = $selected[0].metadata.name |
    .resolvedLbAnnotations = provider_annotations;

def template_values($config):
    walk(if type == "string" then
        gsub("@TENANT_URL@";$config.tenantUrl) |
        gsub("@TENANT_ID@";$config.tenantId) |
        gsub("@DOMAIN@";$config.domain) |
        gsub("@STORAGE_CLASS@";$config.actualStorageClass) |
        gsub("@UI_ADMIN@";$config.uiAdminUsername) |
        gsub("@UI_EMAIL@";$config.uiAdminEmail) |
        gsub("@TENANT_HOST@";$config.tenantHost)
    else . end);

def dns_values($lock):
    . as $c |
    {sources:["gateway-httproute"],logLevel:"info",policy:"sync",registry:"txt",
     enableGatewayListenerSets:true,domainFilters:[$c.domain],txtOwnerId:$c.dnsOwnerId,
     extraArgs:["--txt-prefix=reg-%{record_type}.","--managed-record-types=A","--managed-record-types=AAAA","--managed-record-types=CNAME"]}
    + (if $c.actualDns == "custom" then $c.dnsValues else
        {provider:{name:"webhook",webhook:{
            image:{repository:(if $c.actualDns == "ionos" then "ghcr.io/ionos-cloud/external-dns-ionos-webhook" else "docker.io/hetzner/external-dns-hetzner-webhook" end),tag:$lock.dnsWebhookPins[$c.actualDns]},
            env:([{name:(if $c.actualDns == "ionos" then "IONOS_API_KEY" else "HETZNER_TOKEN" end),valueFrom:{secretKeyRef:{name:"external-dns",key:"token"}}}]
                 + (if $c.actualDns == "ionos" then [{name:"DRY_RUN",value:"false"},{name:"LOG_LEVEL",value:"info"}] else [] end))}}}
      end);

def network_overrides($lock):
    . as $c |
    reduce ($c.upstreamAnnotationKeys // (["network-zone","location","use-private-ip","protocol","type","health-check-protocol","uses-proxyprotocol","disable-private-ingress"] | map("load-balancer.hetzner.cloud/"+.)))[] as $key ({}; .[$key]=null) |
    {"INFRA/network/envoy":{envoyProxy:{service:{annotations:(. + $c.resolvedLbAnnotations)}}}}
    + (if $c.externalDns then {"INFRA/network/external-dns":{"external-dns":($c|dns_values($lock))}} else {} end);

def helm_value: tojson | tojson | tojson;

def network_values($lock):
    . as $c | network_overrides($lock) | to_entries | to_entries |
    map(.key as $i | .value as $v |
        "{{ \(if $i == 0 then "if" else "else if" end) eq .path.path \($v.key|tojson) }}\nspec:\n  source:\n" +
        (if $v.key == "INFRA/network/external-dns" then
            "    repoURL: https://kubernetes-sigs.github.io/external-dns/\n    targetRevision: \($lock.helmPins["external-dns"]|tojson)\n    path: null\n    chart: external-dns\n"
         else "" end) +
        "    helm:\n      valuesObject: null\n" +
        (if $v.key == "INFRA/network/external-dns" then "      valueFiles: []\n      parameters: []\n" else "" end) +
        "      values: {{ \((if $v.key == "INFRA/network/external-dns" then $v.value["external-dns"] else $v.value end)|helm_value) }}" +
        (if $v.key == "INFRA/network/envoy" then "\n  ignoreDifferences:\n    - group: gateway.envoyproxy.io\n      kind: EnvoyProxy\n      name: envoy\n      namespace: infrastructure\n      jsonPointers:\n        - /spec/provider/kubernetes/envoyService/externalTrafficPolicy\n  syncPolicy:\n    syncOptions:\n      - CreateNamespace=true\n      - ServerSideApply=true\n      - RespectIgnoreDifferences=true" else "" end)
    ) | (join("\n") + "\n{{ end }}\n") as $patch |
    {tag:$lock.argoRevision,excludes:(["INFRA/network/bind9","INFRA/network/cluster-issuer"] +
        (if $c.externalDns then [] else ["INFRA/network/external-dns"] end)),esbTemplatePatch:$patch};

def native_values($lock; $overrides; $routing):
    . as $c | $overrides | to_entries | to_entries |
    map(.key as $i | .value as $v |
        "{{ \(if $i == 0 then "if" else "else if" end) eq .path.path \($v.key|tojson) }}\n  source:\n    helm:\n      valuesObject: null\n      values: {{ \($v.value|helm_value) }}") |
    (join("\n") + "\n{{ end }}\n") as $conditional |
    {tag:$lock.argoRevision,esbTemplatePatch:($routing+$conditional)} +
    (if $c.ocmExcludes != null then {excludes:$c.ocmExcludes} else {} end);

def tenant_values($defaults):
    . as $c |
    ($defaults.routes // $defaults.ocm_issuer) as $issuer |
    require_that($issuer | type == "array"; "Native issuer routes are missing.") |
    require_that($defaults.ocm_verifier | type == "array"; "Native verifier routes are missing.") |
    {certificate:{enabled:false,secretName:("esb-"+$c.tenantRelease+"-tls")},
     tenant:{domain:$c.domain,id:$c.tenantId,group:$c.tenantId,subdomain:$c.tenantSubdomain,
             region:$c.storageRegion,country:$c.storageCountry},
     openbao:{transit:{mountPath:("ocm-wstack/"+$c.tenantId)}},
     ocm_issuer:($issuer | map(select(.name != "didcomm"))),
     ocm_verifier:(($defaults.ocm_verifier | map(select(.name != "didcomm"))) +
       [$defaults.ocm_verifier[] | select(.path == "/api/verifier/presentation/proof/") |
         .name += "-compat" | .path="/api/presentation/proof"] +
       (if $c.runtimeServices.didcomm then [] else
         [{name:"didcomm-message",method:"POST",path:"/api/didcomm/message/receive",pathType:"Exact",targetPath:"/message/receive",backend:{name:"didcomm-connector",port:9090}}] end))};

def host_aliases($host; $ip):
    map(.hostnames |= map(select(. != $host))) | map(select(.hostnames | length > 0)) |
    if any(.[]; .ip == $ip) then map(if .ip == $ip then .hostnames += [$host] else . end)
    else . + [{ip:$ip,hostnames:[$host]}] end;

def ready_workload:
    (.spec.replicas // 1) as $desired |
    $desired > 0 and .status.observedGeneration >= .metadata.generation and
    (.status.replicas == $desired and .status.updatedReplicas == $desired and
     .status.readyReplicas == $desired and .status.availableReplicas == $desired);

def ipv4_parts:
    require_that(type=="string" and test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$");"Invalid IPv4 address") |
    split(".") | map(. as $text | tonumber | require_that(.<=255 and tostring==$text;"Invalid IPv4 octet"));

def ipv6_parts:
    def hex_number:
        require_that(test("^[0-9a-fA-F]{1,4}$");"Invalid IPv6 group") |
        ascii_downcase | explode | reduce .[] as $digit (0; . * 16 + (if $digit<=57 then $digit-48 else $digit-87 end));
    def groups:
        if .=="" then [] else split(":") | map(
            if contains(".") then ipv4_parts | [.[0]*256+.[1],.[2]*256+.[3]] else [hex_number] end) | add end;
    require_that(type=="string" and contains(":") and test("^[0-9a-fA-F:.]+$");"Invalid IPv6 address") |
    require_that((contains(".")|not) or (split(":")|last|contains("."));"IPv4 must end the IPv6 address") |
    split("::") | require_that(length<=2;"Repeated IPv6 compression") |
    if length==1 then .[0] | groups | require_that(length==8;"Invalid IPv6 group count")
    else (.[0]|groups) as $left | (.[1]|groups) as $right |
        require_that(($left|length)+($right|length)<8;"Invalid IPv6 compression") |
        $left + [range(8-($left|length)-($right|length))|0] + $right
    end;

def ip_family:
    . as $ip | try (ipv4_parts|4) catch (try ($ip|ipv6_parts|6) catch 0);

def ip_key:
    if ip_family==4 then ipv4_parts|map(tostring)|join(".")
    elif ip_family==6 then ipv6_parts|map(tostring)|join(":") else error("Invalid IP address") end;

# Native service contracts and readiness

def container($name): [.spec.template.spec.containers[]? | select(.name==$name)][0];
def environment($name): container($name).env // [] | map({key:.name,value:.}) | from_entries;
def deployment($name): [.[] | select(.kind=="Deployment" and .metadata.name==$name)][0];
def resource($kind;$name): [.[] | select(.kind==$kind and .metadata.name==$name)][0];

def policy_chart_checks:
    . as $documents | deployment("policy") as $d |
    ($d|container("policy")) as $c | ($d|environment("policy")) as $e |
    $d.spec.template.metadata.annotations as $a |
    {deployment:($d!=null),
     image:($c.image=="node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/tsa/policy:1.1.2"),
     publicImage:((any($d.spec.template.spec.imagePullSecrets[]?; (.name // "")!=""))|not),
     providers:($a["inject.xfsc.io/enabled"]=="true" and
        (($a["inject.xfsc.io/needs"] // "" | split(",") | sort)==["did-resolver","nats","signer"]) and
        ($a["inject.xfsc.io/env-prefix"] // "")=="" and
        (($a["inject.xfsc.io/env-replacements"] // "{}" | fromjson)=={})),
     httpPort:($e.HTTP_PORT.value=="8080" and any($c.ports[]?;.name=="http" and .containerPort==8080)),
     servicePort:(any(($documents|resource("Service";"policy")).spec.ports[]?;.port==8080 and .targetPort==8080)),
     policyRepository:($e.POLICY_REPOSITORY_CLONE_URL.value=="https://github.com/eclipse-xfsc/rego-policies.git" and $e.POLICY_REPO_FOLDER.value=="Policies"),
     noPlaceholders:($c.env|tojson|contains("NAMESPACE")|not)};

# Provider references are resolved against all selected charts, across namespaces.
def provider_contract_errors:
    . as $docs |
    [$docs[]|select(.kind=="ResourceProvider")|{name:.metadata.name,namespace:.metadata.namespace,scope:(.spec.scope // "Namespaced")}] as $providers |
    [$docs[]|select(.kind=="Deployment" or .kind=="StatefulSet" or .kind=="DaemonSet")|
      . as $workload | .spec.template.metadata.annotations as $a |
      select($a["inject.xfsc.io/enabled"]=="true") |
      ($a["inject.xfsc.io/needs"] // "" | split(",")[] | gsub("^ +| +$";"")) as $name |
      select($name!="" and (any($providers[];.name==$name and (.scope=="Cluster" or .namespace==$workload.metadata.namespace))|not)) |
      {workload:($workload.metadata.namespace+"/"+$workload.metadata.name),provider:$name}];

def verification_chart_checks:
    . as $documents |
    deployment("credential-verification-service") as $d |
    ($d|environment("credential-verification-service")) as $env |
    $d.spec.template.metadata.annotations as $a |
    $env.CREDENTIALVERIFICATION_CASSANDRA_USER.valueFrom.secretKeyRef as $user |
    $env.CREDENTIALVERIFICATION_CASSANDRA_PASSWORD.valueFrom.secretKeyRef as $password |
    $env.CREDENTIALVERIFICATION_STATESIGNINGKEY.valueFrom.secretKeyRef as $state |
    {deployment:($d!=null),
     imagePullSecret:(any($d.spec.template.spec.imagePullSecrets[]?; .name=="esb-ocm-public-registry")),
     providerInjection:($a["inject.xfsc.io/enabled"]=="true" and $a["inject.xfsc.io/env-prefix"]=="CREDENTIALVERIFICATION" and
        (($a["inject.xfsc.io/needs"] // "" | split(",") | sort)==["cassandra","did-resolver","nats","signer","storageservice"]) and
        (($a["inject.xfsc.io/env-replacements"] // "{}" | fromjson)=={})),
     stateSigningSecret:($state.name=="credential-verification-service-state-signing" and $state.key=="state-signing-key" and
        ($documents|resource("Secret";$state.name)|.data["state-signing-key"]|type=="string" and length>0)),
     cassandraCredentials:($user.key=="username" and $password.key=="password" and $user.name!=null and $user.name==$password.name),
     cassandraClaim:(any($documents[]; .kind=="ResourceClaim" and .spec.type=="cassandra" and
        .spec.providerRef.name=="cassandra" and .spec.externalSecretRef.name==$user.name and .spec.parameters.keyspace=="ocm")),
     storageEndpoint:($env.CREDENTIALVERIFICATION_STORAGE_URL.value=="http://storage-service.ocm-wstack.svc.cluster.local:8080"),
     natsProtocol:($env.CREDENTIALVERIFICATION_PROTOCOL.value=="nats"),
     natsTimeout:($env.CREDENTIALVERIFICATION_NATS_REQUEST_TIMEOUT.value=="10"),
     externalPresentation:($env.CREDENTIALVERIFICATION_EXTERNALPRESENTATION_ENABLED.value=="true" and
        ($env.CREDENTIALVERIFICATION_EXTERNALPRESENTATION_AUTHORIZEENDPOINT.value // "" |
          test("^http://credential-verification-service\\.ocm-wstack\\.svc\\.cluster\\.local:8080/v1/tenants/[a-z0-9_-]+/presentation/$"))),
     noPlaceholders:(($d|container("credential-verification-service")).env|tojson|test("NAMESPACE|@TENANT_ID@|\\.default\\.svc")|not),
     noIngress:(any($documents[];.kind=="Ingress")|not)};

def validate_chart($chart):
    . as $documents |
    if $chart=="OCM W-Stack/Credential Verification Service Chart" then
        verification_chart_checks | all(.[];.==true)
    elif $chart=="OCM W-Stack/Policy Chart" then
        policy_chart_checks | all(.[];.==true)
    elif $chart=="INFRA/core/nats" then
        resource("StatefulSet";"nats") |
        any(.spec.template.spec.containers[]?; .name=="nats" and any(.ports[]?; .containerPort==8222))
    elif $chart=="INFRA/core/universal-resolver" then
        resource("Service";"universal-resolver-service") as $service |
        [$service.spec.ports[]? | select(.port==8080)][0] as $port |
        [$documents[] | select(.kind=="Deployment") |
         select(.spec.template.metadata.labels as $labels | $service.spec.selector | to_entries | length>0 and all(.[]; $labels[.key]==.value))][0] as $deployment |
        ($port.targetPort // $port.port) as $target |
        $port!=null and any($deployment.spec.template.spec.containers[]?.ports[]?;
            if $target|type=="number" then .containerPort==$target else .name==$target end)
    elif $chart=="OCM W-Stack/Pre Authorization Bridge Chart" or $chart=="OCM W-Stack/Well Known Chart" then
        (if $chart|contains("Pre Authorization") then "pre-authorization-bridge" else "well-known-service" end) as $name |
        deployment($name) as $d |
        $d.spec.template.metadata.annotations as $annotations |
        $annotations["inject.xfsc.io/enabled"]=="true" and
        $annotations["inject.xfsc.io/env-prefix"]==(if $name=="pre-authorization-bridge" then "PREAUTHBRIDGE" else "WELLKNOWN_SERVICE" end) and
        (if $name=="well-known-service" then
            ($d|environment($name)).WELLKNOWN_SERVICE_CREDENTIAL_ISSUER_IMPORTER.value | .==null or .=="BROADCAST"
         else
            ($d|environment($name)) as $e |
            $e.PREAUTHBRIDGE_REDIS_USERNAME.valueFrom.secretKeyRef as $user |
            $e.PREAUTHBRIDGE_REDIS_PASSWORD.valueFrom.secretKeyRef as $password |
            ((any($d.spec.template.spec.imagePullSecrets[]?; (.name // "")!=""))|not) and
            $user.name!=null and $user.name==$password.name and $user.key=="username" and $password.key=="password" and
            any($documents[]; .kind=="ResourceClaim" and .spec.type=="redis" and .spec.externalSecretRef.name==$user.name and
                .spec.providerRef.name=="redis" and .spec.parameters.acl=={keys:["auth:*"]})
         end)
    elif $chart=="INFRA/observability/opentelemtry" then
        [.[] | select((.kind=="Deployment" or .kind=="StatefulSet") and
            .metadata.labels["app.kubernetes.io/name"]=="grafana" and .metadata.labels["app.kubernetes.io/instance"]=="observability")] as $workloads |
        $workloads[0] as $d | $d.spec.template.spec as $pod |
        [$pod.containers[]? | select(.name=="grafana")][0] as $grafana |
        [$grafana.volumeMounts[]? | select(.mountPath=="/var/lib/grafana")][0] as $mount |
        ($workloads|length)==1 and
        ($d.kind!="Deployment" or (($d.spec.replicas // 1)==1 and $d.spec.strategy.type=="Recreate" and $d.spec.strategy.rollingUpdate==null)) and
        (any($pod.initContainers[]?; .name=="init-chown-data")|not) and
        $pod.securityContext.runAsNonRoot==true and $pod.securityContext.runAsUser==472 and
        $pod.securityContext.runAsGroup==472 and $pod.securityContext.fsGroup==472 and
        $pod.securityContext.fsGroupChangePolicy=="Always" and $mount!=null and $mount.readOnly!=true and
        $mount.subPath==null and $mount.subPathExpr==null and
        any($pod.volumes[]?; .name==$mount.name and .persistentVolumeClaim.claimName!=null)
    else
        (if $chart=="OCM W-Stack/Policy Chart" then "policy" elif $chart=="OCM W-Stack/Didcomm" then "didcomm-connector" else "credential-verification-service" end) as $name |
        [.[] | select(.kind=="Deployment" and any(.spec.template.spec.containers[]?; .name==$name))][0] as $d |
        ($d|container($name)) as $container | ($d|environment($name)) as $e |
        $d!=null and ($container.env|tojson|contains("NAMESPACE")|not) and
        (if $name=="didcomm-connector" then
            $e.DIDCOMMCONNECTOR_DATBASE_HOST.value=="cassandra.infrastructure.svc.cluster.local" and
            ($e.DIDCOMMCONNECTOR_DATBASE_PORT.value|tostring)=="9042" and
            $e.DIDCOMMCONNECTOR_DIDCOMM_RESOLVERURL.value=="http://universal-resolver-service.infrastructure.svc.cluster.local:8080" and
            $e.DIDCOMMCONNECTOR_CLOUDFORWARDING_NATS_URL.value=="nats://nats.infrastructure.svc.cluster.local:4222" and
            $e.DIDCOMMCONNECTOR_DATBASE_PASSWORD.valueFrom.secretKeyRef=={name:"esb-credential-verification-cassandra",key:"cassandra-password"} and
            ($e.DIDCOMMCONNECTOR_URL.value|test("^https://[^/]+/api/didcomm$")) and
            (any($documents[]; .kind=="Ingress")|not)
         else false
         end)
    end;

def validate_datasources:
    [.[] | .datasources[]?] as $sources |
    ($sources|length)>0 and all($sources[]; (.name // "")!="") and
    ($sources|group_by([(.orgId // 1),.name])|all(.[];length==1)) and
    ($sources|map(select(.uid!=null))|group_by([(.orgId // 1),.uid])|all(.[];length==1)) and
    ($sources|map(select(.isDefault==true))|group_by(.orgId // 1)|all(.[];length==1)) and
    any($sources[]; (.orgId // 1)==1 and .isDefault==true);

def job_condition($name): any(.status.conditions[]?; .type==$name and .status=="True");
def ignored_pod($jobs):
    . as $pod |
    [.metadata.ownerReferences[]? | select(.kind=="Job" and .controller==true and .uid!=null)][0] as $owner |
    if .status.phase!="Failed" then null
    elif $owner!=null and any($jobs[]; .metadata.namespace==$pod.metadata.namespace and .metadata.uid==$owner.uid and
        job_condition("Complete") and (job_condition("Failed")|not)) then "failed-attempt-of-completed-job"
    elif (.metadata.ownerReferences // [] | length)==0 and .metadata.namespace=="security" and
         (.metadata.name|test("^openbao-bootstrap-debug-[0-9]+$")) and
         .metadata.labels["app.kubernetes.io/name"]=="openbao-bootstrap" and
         .metadata.labels["app.kubernetes.io/instance"]=="openbao" and
         .metadata.labels["app.kubernetes.io/component"]=="openbao-bootstrap" and
         .spec.serviceAccountName=="openbao-bootstrap" and .spec.restartPolicy=="Never" and
         (.spec.containers|length)==1 and .spec.containers[0].name=="bootstrap" then "terminal-openbao-diagnostic"
    else null end;

def managed_namespace: IN("observability","security","argocd","infrastructure","ocm-wstack");
def pod_readiness($jobs):
    [.items[] | select((.metadata.namespace|managed_namespace) and .metadata.deletionTimestamp==null)] as $pods |
    [$jobs.items[] | select((.metadata.namespace|managed_namespace) and .metadata.deletionTimestamp==null and job_condition("Failed")) |
        {namespace:.metadata.namespace,name:.metadata.name}] as $failed |
    {ready:(($failed|length)==0 and any($pods[]; .metadata.namespace=="ocm-wstack") and
            all($pods[]; ignored_pod($jobs.items)!=null or .status.phase=="Succeeded" or
                (.status.phase=="Running" and (.status.containerStatuses|length)>0 and all(.status.containerStatuses[]; .ready)))),
     ignored:[$pods[] | . as $pod | ignored_pod($jobs.items) | select(.!=null) | {namespace:$pod.metadata.namespace,name:$pod.metadata.name,reason:.}],
     failedJobs:$failed};

def owned_pods($deployment; $pods; $replicasets):
    [$replicasets[] | select(any(.metadata.ownerReferences[]?; .uid==$deployment.metadata.uid and .controller==true)) | .metadata.uid] as $ids |
    [$pods[] | select(.metadata.deletionTimestamp==null and .status.phase=="Running" and .status.podIP!=null and
        any(.metadata.ownerReferences[]?; .controller==true and (.uid as $uid | $ids|index($uid)!=null)))];

def verification_nats_environment:
    {CREDENTIALVERIFICATION_NATS_HOST:"nats.infrastructure.svc.cluster.local",
     CREDENTIALVERIFICATION_NATS_PORT:"4222",CREDENTIALVERIFICATION_NATS_REQUEST_TIMEOUT:"10s",
     CREDENTIALVERIFICATION_NATS_URL:"nats://nats.infrastructure.svc.cluster.local:4222"};

def verification_nats_contract:
    (.spec.template.spec // .spec) as $spec |
    [$spec.containers[]? | select(.name=="credential-verification-service")] as $containers |
    ($containers|length)==1 and
    (verification_nats_environment | to_entries | all(.[]; . as $expected |
        [$containers[0].env[]? | select(.name==$expected.key)] as $entries |
        ($entries|length)==1 and $entries[0].value==$expected.value and $entries[0].valueFrom==null));

def verification_nats_ready($pods; $replicasets):
    . as $d | owned_pods($d;$pods;$replicasets) as $current |
    ready_workload and verification_nats_contract and ($current|length)==(.spec.replicas // 1) and
    all($current[]; verification_nats_contract and
        .metadata.annotations["esb.xfsc.io/credentials"]==$d.spec.template.metadata.annotations["esb.xfsc.io/credentials"] and
        ([.spec.containers[] | select(.name=="credential-verification-service")][0].image)==($d|container("credential-verification-service")).image);

def required_subjects($name):
    {"pre-authorization-bridge":["auth.authorization.generate","auth.authorization.validate"],
     "well-known-service":["wellknown.issuer.registration","wellknown.issuer.metadata"]}[$name] // [];

def service_listeners($pods; $replicasets; $connections):
    . as $d |
    owned_pods($d;$pods;$replicasets) | map(select(
        any(.spec.containers[]; .name==$d.metadata.name and .image==($d|container($d.metadata.name)).image) and
        .metadata.annotations["esb.xfsc.io/credentials"]==$d.spec.template.metadata.annotations["esb.xfsc.io/credentials"])) as $current |
    required_subjects($d.metadata.name) as $subjects |
    {name:$d.metadata.name,deploymentUid:$d.metadata.uid,generation:$d.metadata.generation,
     podUids:([$current[].metadata.uid]|sort),subjects:$subjects,
     ready:(($d|ready_workload) and ($current|length)==($d.spec.replicas // 1) and
        all($current[]; .status.podIP as $ip | all($subjects[]; . as $subject |
            any($connections[]; .ip==$ip and (.subscriptions_list // [] | index($subject)!=null)))))};

def secret_references:
    .spec.template.spec as $spec |
    [($spec.containers[]?, $spec.initContainers[]?) |
        (.env[]?.valueFrom.secretKeyRef | select(.!=null) | {name,key,optional}),
        (.envFrom[]?.secretRef | select(.!=null) | {name,key:null,optional})] +
    [$spec.volumes[]? |
        (.secret | select(.!=null) | .name=.secretName),
        (.projected.sources[]?.secret | select(.!=null)) |
        . as $secret | if .items!=null then .items[] | {name:$secret.name,key:.key,optional:$secret.optional}
        else {name,key:null,optional} end];

def credential_references($secrets):
    secret_references |
    map(. as $ref | [$secrets[] | select(.metadata.name==$ref.name)][0] as $secret |
        require_that($secret!=null or $ref.optional==true; "CONSUMER_SECRET_PENDING") |
        (if $ref.key!=null then [$ref.key] else ($secret.data // {} | keys) end)[] as $key |
        require_that($secret.data[$key]!=null or $ref.optional==true; "CONSUMER_SECRET_KEY_PENDING") |
        [$ref.name+"/"+$key,$secret.data[$key]]) | unique_by(.[0]) | sort_by(.[0]);

# Public provisioning status contains references and condition codes only.
def condition_reason:
    (.reason // "Pending") | if type=="string" and test("^[A-Za-z][A-Za-z0-9_-]{0,63}$") then . else "Pending" end;

def native_credential_status($claims; $external; $secrets):
    [.[] | . as $deployment | secret_references[] | select(.optional!=true) |
        . as $ref | [$secrets[] | select(.metadata.name==$ref.name)][0] as $secret |
        [$external[] | select((.spec.target.name // .metadata.name)==$ref.name)][0] as $es |
        [$claims[] | select($es!=null and .spec.externalSecretRef.name==$es.metadata.name)][0] as $claim |
        [$claim.status.conditions[]? | select(.type=="Ready")][0] as $condition |
        [$es.status.conditions[]? | select(.type=="Ready")][0] as $sync |
        {workload:$deployment.metadata.name,secret:$ref.name,key:$ref.key,
         present:($secret!=null and ($ref.key==null or ($secret.data[$ref.key] // "")!="")),
         externalSecret:($es.metadata.name // null),
         externalSecretReady:($es==null or ($sync.status=="True" and $sync.reason!="SecretDeleted")),
         externalSecretReason:(if $es==null then null else $sync|condition_reason end),
         claim:($claim.metadata.name // null),
         claimReady:($claim==null or ($condition.status=="True" and
            ($condition.observedGeneration // $claim.status.observedGeneration)==$claim.metadata.generation)),
         claimReason:(if $claim==null then null else $condition|condition_reason end)} |
        .ready=(.present and .externalSecretReady and .claimReady)] |
    unique_by([.workload,.secret,.key]) |
    {ready:all(.[];.ready),pending:map(select(.ready|not))};

def credential_refresh_targets($pending; $claims; $planned):
    . as $external |
    [$pending.pending[] | select(.present==false and .claimReason=="ClaimSecretPending") |
     . as $waiting |
     [$claims[] | select(.metadata.name==$waiting.claim and .metadata.namespace=="ocm-wstack")][0] as $claim |
     [$external[] | select(.metadata.name==$waiting.externalSecret and .metadata.namespace=="ocm-wstack")][0] as $es |
     [$planned[] | select(.kind=="ResourceClaim" and .metadata.namespace=="ocm-wstack" and .metadata.name==$waiting.claim)][0] as $expectedClaim |
     [$planned[] | select(.kind=="ExternalSecret" and .metadata.namespace=="ocm-wstack" and .metadata.name==$waiting.externalSecret)][0] as $expectedSecret |
     select($expectedClaim!=null and $expectedSecret!=null and $claim.spec==$expectedClaim.spec) |
     select(($es.spec.target.name // $es.metadata.name)==($expectedSecret.spec.target.name // $expectedSecret.metadata.name) and
            $es.spec.secretStoreRef==$expectedSecret.spec.secretStoreRef and
            ([$es.spec.data[]? | {secretKey,remoteRef:{key:.remoteRef.key,property:.remoteRef.property}}] | sort_by(.secretKey))==
            ([$expectedSecret.spec.data[]? | {secretKey,remoteRef:{key:.remoteRef.key,property:.remoteRef.property}}] | sort_by(.secretKey))) |
     select(any($claim.status.conditions[]?; .type=="Ready" and .status=="False" and .reason=="ClaimSecretPending" and
        (.observedGeneration // $claim.status.observedGeneration)==$claim.metadata.generation)) |
     select(($es.metadata.uid // "")!="" and ($es.metadata.resourceVersion // "")!="") |
     $es] | unique_by(.metadata.uid);

def secret_value($secrets; $name; $key):
    [$secrets[] | select(.metadata.name==$name)][0].data[$key] |
    require_that(type=="string" and length>0; "CREDENTIAL_SECRET_INCOMPLETE") | @base64d;

def env_value($env; $name; $secrets):
    $env[$name] as $entry |
    if $entry.value!=null then $entry.value
    else $entry.valueFrom.secretKeyRef as $ref |
        require_that($ref.name!=null; "ENVIRONMENT_CONTRACT") |
        secret_value($secrets;$ref.name;$ref.key)
    end;

def redis_contract($claims; $provider; $secrets; $admin; $external):
    environment("pre-authorization-bridge") as $env |
    $env.PREAUTHBRIDGE_REDIS_USERNAME.valueFrom.secretKeyRef as $user |
    $env.PREAUTHBRIDGE_REDIS_PASSWORD.valueFrom.secretKeyRef as $password |
    require_that($user.name!=null and $user.name==$password.name and $user.key=="username" and $password.key=="password"; "BRIDGE_REDIS_CONTRACT") |
    [$claims[] | . as $claim | select(.spec.type=="redis" and
        any($external[]; .metadata.name==$claim.spec.externalSecretRef.name and (.spec.target.name // .metadata.name)==$user.name))][0] as $claim |
    require_that($claim!=null and $claim.spec.providerRef.name==$provider.metadata.name and
        ($claim.status.providerRef==null or $claim.status.providerRef==$provider.metadata.name); "REDIS_CLAIM_PENDING") |
    require_that($claim.spec.parameters.acl.keys==["auth:*"] and ($claim.spec.parameters.acl.channels // []|length)==0 and
        ($claim.spec.parameters.acl.commands // []|length)==0; "REDIS_ACL_CONTRACT") |
    $provider.spec.outputs.env as $p |
    require_that($p.REDIS_ISCLUSTER=="false" and $p.REDIS_TLS=="false"; "REDIS_TOPOLOGY_CONTRACT") |
    require_that($p.REDIS_HOSTS=="redis.infrastructure.svc.cluster.local:6379"; "REDIS_ENDPOINT_CONTRACT") |
    require_that(env_value($env;"PREAUTHBRIDGE_REDIS_HOSTS";$secrets)==$p.REDIS_HOSTS; "BRIDGE_REDIS_ENDPOINT") |
    require_that($env.PREAUTHBRIDGE_REDIS_ISCLUSTER==null or env_value($env;"PREAUTHBRIDGE_REDIS_ISCLUSTER";$secrets)=="false"; "BRIDGE_REDIS_TOPOLOGY") |
    secret_value($secrets;$user.name;"username") as $username |
    require_that($username!="default" and $username!="" and ($username|test("[\\s\\x00-\\x1f]")|not); "REDIS_ACCOUNT_CONTRACT") |
    {endpoint:{host:"redis.infrastructure.svc.cluster.local",port:6379},username:$username,
     password:secret_value($secrets;$user.name;"password"),database:($claim.spec.parameters.database // 0),
     admin:{username:(if $admin.data.username then ($admin.data.username|@base64d) else null end),
            password:secret_value([$admin];$admin.metadata.name;"password")}};

def api_https_port:
    .spec.ports as $ports |
    [$ports[] | select((.protocol // "TCP")=="TCP" and (.name=="https" or ($ports|length)==1))] |
    require_that(length==1;"GUARD_API_SERVICE") | .[0];

def api_backends($slices; $endpoints):
    api_https_port as $https |
    [$slices.items[]? | select(.metadata.namespace=="default" and
        .metadata.labels["kubernetes.io/service-name"]=="kubernetes" and (.addressType|IN("IPv4","IPv6"))) |
        . as $slice | .ports[]? | select((.protocol // "TCP")=="TCP" and .name==$https.name) as $port |
        $slice.endpoints[]? | select(.conditions.ready!=false and .conditions.terminating!=true) |
        .addresses[] | require_that(ip_family==(if $slice.addressType=="IPv4" then 4 else 6 end);"GUARD_API_ENDPOINTS") |
        {ip:.,port:$port.port}] as $found |
    if ($found|length)>0 or $endpoints==null then $found else
        require_that($endpoints.metadata.name=="kubernetes" and $endpoints.metadata.namespace=="default";"GUARD_API_ENDPOINTS") |
        [$endpoints.subsets[]? | . as $subset | .ports[]? |
            select((.protocol // "TCP")=="TCP" and .name==$https.name) as $port |
            $subset.addresses[]? | {ip:.ip,port:$port.port}]
    end;

def api_egress($backends):
    require_that(.metadata.name=="kubernetes" and .metadata.namespace=="default";"GUARD_API_SERVICE") |
    api_https_port as $https |
    require_that($backends|length>0;"GUARD_API_ENDPOINTS_PENDING") |
    ([.spec.clusterIP, .spec.clusterIPs[]?] | unique | map(select(.!=null))) as $ips |
    require_that(($ips|length)>0 and all($ips[];ip_family!=0) and
        ($https.port|type)=="number" and $https.port>=1 and $https.port<=65535 and ($https.port|floor)==$https.port;"GUARD_API_SERVICE") |
    ([$ips[]|{ip:.,port:$https.port}]+$backends) |
    require_that(all(.[]; (.port|type)=="number" and .port>=1 and .port<=65535 and (.port|floor)==.port and
        (.ip|ip_family)!=0);"GUARD_API_ENDPOINTS") |
    group_by(.port) | map({ports:[{protocol:"TCP",port:.[0].port}],
        to:([.[].ip]|unique|map({ipBlock:{cidr:(.+(if contains(":") then "/128" else "/32" end))}}))});

def guard_dns_egress($slices):
    require_that((.metadata.name|type)=="string" and .metadata.namespace=="kube-system" and
        (.spec.selector|type)=="object" and (.spec.selector|length)>0;"GUARD_DNS_SERVICE") |
    . as $service |
    [.spec.ports[] | select(.port==53 and (.protocol|IN("UDP","TCP")))] as $ports |
    [$slices.items[]? | select(.metadata.namespace=="kube-system" and
        .metadata.labels["kubernetes.io/service-name"]==$service.metadata.name) |
        select(any(.endpoints[]?; .conditions.ready!=false and .conditions.terminating!=true)) |
        .ports[]? | . as $p | select(any($ports[]; .name==$p.name and .protocol==$p.protocol)) |
        {port,protocol}] | unique as $backends |
    require_that(($backends|length)>0 and all($ports[]; .protocol as $protocol |
        any($backends[];.protocol==$protocol));"GUARD_DNS_ENDPOINTS_PENDING") |
    require_that(all($backends[]; (.port|type)=="number" and .port>=1 and .port<=65535 and
        (.port|floor)==.port);"GUARD_DNS_ENDPOINTS") |
    [{to:[{namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":"kube-system"}},
        podSelector:{matchLabels:$service.spec.selector}}],ports:$backends}];

def validate_guard_status($deployments;$pods;$replicasets;$now):
    . as $report |
    (["pre-authorization-bridge","well-known-service"] | all(.[]; . as $name |
        [$deployments[]|select(.metadata.name==$name)][0] as $d |
        [$report.services[]?|select(.name==$name)][0] as $service |
        ($d|service_listeners($pods;$replicasets;[])) as $current |
        ($d|ready_workload) and $service.ready==true and $service.deploymentUid==$d.metadata.uid and
        $service.generation==$d.metadata.generation and
        $current.podUids==$service.podUids and ($current.podUids|length)==($d.spec.replicas // 1) and
        all(required_subjects($name)[]; . as $subject | $service.subjects|index($subject)!=null))) as $listeners |
    ([$deployments[]|select(.metadata.name=="credential-verification-service")][0] | verification_nats_ready($pods;$replicasets)) as $verification |
    (try ($report.checkedAt|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601) catch 0) as $checked |
    .ready=(.ready==true and .credentials.synchronized==true and .redis.authenticated==true and
        $listeners and $verification and $now >= $checked and ($now-$checked)<60) |
    .verificationNats={ready:$verification} |
    if $verification|not then .code="VERIFICATION_NATS_CONTRACT" else . end;

def retrieval_recovery_contract($pods):
    . as $d |
    if .status.availableReplicas>0 then null else
        container("credential-retrieval-service") as $container |
        {"node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/credential-retrieval-service:1.1.5":"sha256:c6ff55eaff0624c9e3f94d23a823c9cbdb2b7235dc6d14180b359ad8e79176ae",
         "node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/credential-retrieval-service:1.1.7-alpha":"sha256:6a9363c4e8c4437fa185bf1dd859c34e1eebc100fcdbbcfc988fd258d4b333d7"} as $images |
        require_that($images[$container.image]!=null;"RETRIEVAL_RECOVERY_CONTRACT") |
        environment("credential-retrieval-service") as $e |
        $e.CREDENTIALRETRIEVAL_CASSANDRA_USER.valueFrom.secretKeyRef as $user |
        $e.CREDENTIALRETRIEVAL_CASSANDRA_PASSWORD.valueFrom.secretKeyRef as $password |
        require_that($e.CREDENTIALRETRIEVAL_MIGRATIONS_TABLE.value=="retrieval_schema_migration" and
            $e.CREDENTIALRETRIEVAL_CASSANDRA_HOSTS.value=="cassandra.infrastructure.svc.cluster.local" and
            ($e.CREDENTIALRETRIEVAL_CASSANDRA_KEYSPACE.value|IN(null,"","ocm")) and
            ($e.CREDENTIALRETRIEVAL_CASSANDRA_PORT.value|IN(null,"9042")) and
            ($e.CREDENTIALRETRIEVAL_MIGRATIONS_TIMEOUT.value|IN(null,"2m")) and
            ($e.CREDENTIALRETRIEVAL_MIGRATIONS_ENABLED.value|IN(null,"true")) and
            $user.name!=null and $user.name==$password.name and $user.key=="username" and $password.key=="password";"RETRIEVAL_RECOVERY_CONTRACT") |
        [$pods[] | . as $pod |
            [.spec.containers[]?|select(.name=="credential-retrieval-service")][0] as $pc |
            [.status.containerStatuses[]?|select(.name=="credential-retrieval-service")][0] as $state |
            ($state.state.terminated // $state.lastState.terminated) as $last |
            if .metadata.deletionTimestamp!=null or $pc.image!=$container.image or $state.imageID==null or
               $state.ready==true or $state.state.running!=null or $last.exitCode!=1 then false
            else require_that($state.imageID|endswith("@"+$images[$container.image]);"RETRIEVAL_RECOVERY_IMAGE") | true end] as $settled |
        if ($settled|length)==0 or any($settled[]; .==false) then null
        else {secret:$user.name,image:$container.image,digest:$images[$container.image]} end
    end;

# Cluster inspection report

# Explicitly accepted deployment-time drift for the healthy Verification service.
def accepted_sync_drift:
    .name=="credential-verification-service-chart" and .sync=="OutOfSync" and .health=="Healthy";

def application_ready:
    .health=="Healthy" and (.sync=="Synced" or accepted_sync_drift);

def inspect_report($c;$lock;$apps;$pods;$pvcs;$jobs;$gateway;$cert;$proxy;$policy;$services;$operational):
    ["storage","network","core","ocm-wstack"] as $sets |
    [$apps.items[] | select(any(.metadata.ownerReferences[]?;
        .kind=="ApplicationSet" and (.name as $name|$sets|index($name)!=null)))] as $owned |
    [$owned[] | {name:.metadata.name,sync:.status.sync.status,health:.status.health.status,revision:.status.sync.revision}] as $applications |
    [$owned[].metadata.ownerReferences[] | select(.kind=="ApplicationSet") | .name | select(. as $name|$sets|index($name)!=null)] | unique as $present |
    [$pvcs.items[] | select((.metadata.namespace|managed_namespace) and .status.phase!="Bound") |
        .metadata.namespace+"/"+.metadata.name] as $pending |
    [$pods.items[] | select((.metadata.namespace|managed_namespace) and .metadata.deletionTimestamp==null)] as $managed |
    ($pods|pod_readiness($jobs)) as $readiness |
    [$services.items[] | select(.spec.type=="LoadBalancer")] as $public |
    ($proxy.spec.provider.kubernetes.envoyService // {}) as $proxyConfig |
    def foreign_keys:
        if $c.actualProvider=="hetzner" then [] else (. // {} | keys | map(select(startswith("load-balancer.hetzner.cloud/")))) end;
    def mapped:
        any(.spec.hostAliases[]?; .ip==$public[0].spec.clusterIP and (.hostnames|index($c.tenantHost)!=null));
    any($managed[]; .metadata.namespace=="ocm-wstack" and .metadata.labels.app=="ocm-orce" and mapped) as $runtimeMapped |
    any($managed[]; .metadata.namespace=="infrastructure" and .metadata.labels["app.kubernetes.io/name"]=="cert-manager" and
        .metadata.labels["app.kubernetes.io/component"]=="controller" and mapped) as $certManagerMapped |
    (($c.internalGatewayRouting|not) or $runtimeMapped) as $routingReady |
    any($policy.status.conditions[]?; .type=="Ready" and .status=="True") as $policyReady |
    ($routingReady and $proxyConfig.externalTrafficPolicy==$c.externalTrafficPolicy and ($proxyConfig.annotations|foreign_keys|length)==0 and
        $policyReady and ($public|length)>0 and all($public[];
            .spec.externalTrafficPolicy==$c.externalTrafficPolicy and (.metadata.annotations|foreign_keys|length)==0 and
            any(.spec.ports[]?;.port==80) and any(.spec.ports[]?;.port==443))) as $gatewayReady |
    [$gateway.status.addresses[]? | {type,value}] as $addresses |
    {
        upstreamCommit:$lock.commit,argoRevision:$lock.argoRevision,tenantId:$c.tenantId,tenantUrl:$c.tenantUrl,
        provider:$c.actualProvider,providerLocations:$c.providerLocations,externalTrafficPolicy:$c.externalTrafficPolicy,storageClass:$c.actualStorageClass,
        ui:{enabled:true,url:($c.tenantUrl+"/orce/"),editorUrl:($c.tenantUrl+"/orce/editor/")},
        applications:$applications,acceptedSyncDifferences:[$applications[]|select(accepted_sync_drift)],gatewayAddresses:$addresses,pendingVolumes:$pending,
        certificateReady:($cert.type=="kubernetes.io/tls" and ($cert.data["tls.crt"]|type)=="string" and ($cert.data["tls.key"]|type)=="string"),
        gatewayConfigurationReady:$gatewayReady,
        gatewayConfiguration:{tenantRouting:{mode:"internal",hostname:$c.tenantHost,clusterIP:$public[0].spec.clusterIP,
            certManagerMapped:$certManagerMapped,runtimeMapped:$runtimeMapped,ready:$routingReady},
            expectedTrafficPolicy:$c.externalTrafficPolicy,proxyTrafficPolicy:$proxyConfig.externalTrafficPolicy,
            foreignAnnotationKeys:($proxyConfig.annotations|foreign_keys),admissionPolicyReady:$policyReady,
            services:[$public[] | {name:.metadata.name,externalTrafficPolicy:.spec.externalTrafficPolicy,
                ports:[.spec.ports[].port],foreignAnnotationKeys:(.metadata.annotations|foreign_keys)}]},
        ocmOperational:$operational,ignoredTerminalPods:$readiness.ignored,failedJobs:$readiness.failedJobs,
        clusterReady:($operational.ready==true and ($present|length)==4 and all($applications[];application_ready) and
            ($pending|length)==0 and $readiness.ready and
            any($managed[];.metadata.namespace=="ocm-wstack" and .metadata.labels.app=="ocm-orce") and
            ($c.useExternalMongo or any($managed[];.metadata.namespace=="ocm-wstack" and .metadata.labels.app=="ocm-ui-mongodb"))),
        pods:[$managed[] | {name:.metadata.name,namespace:.metadata.namespace,phase:.status.phase,
            containers:[.status.containerStatuses[]? | {name,image,imageID,ready,restarts:.restartCount}]}],
        dns:{automatic:$c.externalDns,hostname:$c.tenantHost,targets:[$addresses[].value],
            instructions:(if $c.externalDns then "ExternalDNS manages the tenant record." else
                "Point the tenant hostname"+(if $c.publicDashboards then ", argocd."+$c.domain+" and grafana."+$c.domain else "" end)+
                " to these gateway addresses. Public TCP 443 must reach Envoy. Remove stale A/AAAA records." end)}
    };

# Keep standard DNS; add only verified alternate DNS backend ports.
def runtime_dns_fallback($slices):
    try (guard_dns_egress($slices) | map(.ports |= map(select(.port != 53))) |
        map(select(.ports|length>0))) catch [];
OCM_FILTERS
        ;;
    readiness) cat <<'OCM_READINESS'
# Current replica counts must describe the current generation. A previous
# progress deadline remains diagnostic information while Kubernetes recovers.
def workload_ready:
    (.spec.replicas // 1) as $desired |
    .metadata.deletionTimestamp == null and
    if .kind == "Pod" then
        .status.phase == "Running" and
        any(.status.conditions[]?; .type == "Ready" and .status == "True") and
        ((.status.containerStatuses // []) | length) == (.spec.containers | length) and
        all(.status.containerStatuses[]?; .ready == true)
    else
        (.status.observedGeneration // 0) >= .metadata.generation and
        (.status.replicas // 0) == $desired and
        (.status.readyReplicas // 0) == $desired and
        (.status.updatedReplicas // 0) == $desired and
        if .kind == "Deployment" then
            .spec.paused != true and (.status.availableReplicas // 0) >= $desired
        elif .kind == "StatefulSet" then
            ($desired == 0 or
                (.status.currentRevision != null and .status.currentRevision == .status.updateRevision)) and
            ((.spec.minReadySeconds // 0) == 0 or (.status.availableReplicas // 0) >= $desired)
        else false end
    end;

def workload_report($expected):
    [.items[] | select($expected == [] or
        ((.kind + "/" + .metadata.name) as $key | $expected | index($key) != null))] as $objects |
    [$objects[] | {
        resource:(.kind + "/" + .metadata.name), ready:workload_ready,
        generation:.metadata.generation, observedGeneration:.status.observedGeneration,
        desired:(.spec.replicas // 1), updated:(.status.updatedReplicas // 0),
        readyReplicas:(.status.readyReplicas // 0), available:(.status.availableReplicas // 0),
        conditions:[.status.conditions[]? | {type,status,reason,message}]
    }] as $reports |
    ($expected - [$reports[].resource]) as $missing |
    {ready:($reports != [] and $missing == [] and all($reports[]; .ready)),
     missing:$missing, workloads:$reports};

def pod_problems:
    [.items[] | select(.metadata.deletionTimestamp == null and .status.phase != "Succeeded") |
        select(.status.phase != "Running" or
            (any(.status.conditions[]?; .type == "Ready" and .status == "True") | not)) |
        {name:.metadata.name, phase:.status.phase, conditions:.status.conditions,
         containers:[(.status.initContainerStatuses[]?, .status.containerStatuses[]?) |
             {name,image,ready,restartCount,state,lastState}]}];
OCM_READINESS
        ;;
    upstream-patch) cat <<'OCM_UPSTREAM_PATCH'
diff --git a/INFRA/app-management/app-namespace/templates/openbao-access-provision-job.yaml b/INFRA/app-management/app-namespace/templates/openbao-access-provision-job.yaml
index f8a0e6b..c055b2a 100644
--- a/INFRA/app-management/app-namespace/templates/openbao-access-provision-job.yaml
+++ b/INFRA/app-management/app-namespace/templates/openbao-access-provision-job.yaml
@@ -218,9 +218,8 @@ spec:
                 echo "Mount ${STORE_MOUNT} already exists."
 
                 MOUNT_TYPE="$(
-                  echo "$MOUNTS_JSON" |
-                    sed -n \
-                      "s#.*\"${STORE_MOUNT}/\"[[:space:]]*:[[:space:]]*{[^}]*\"type\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*#\\1#p"
+                  bao secrets list -format=table |
+                    awk -v mount="${STORE_MOUNT}/" '$1 == mount {print $2; exit}'
                 )"
 
                 if [ -z "$MOUNT_TYPE" ]; then
diff --git a/INFRA/observability/opentelemtry/Chart.yaml b/INFRA/observability/opentelemtry/Chart.yaml
index 50ddad1..c5f5de2 100644
--- a/INFRA/observability/opentelemtry/Chart.yaml
+++ b/INFRA/observability/opentelemtry/Chart.yaml
@@ -9,36 +9,36 @@ appVersion: "1.0.0"
 dependencies:
   - name: opentelemetry-collector
     alias: otelcollector
-    version: ">=0.120.0"
+    version: "0.177.0"
     repository: https://open-telemetry.github.io/opentelemetry-helm-charts
     condition: otelcollector.enabled
 
   - name: kube-prometheus-stack
     alias: monitoring
-    version: ">=85.0.0"
+    version: "92.13.1"
     repository: https://prometheus-community.github.io/helm-charts
     condition: monitoring.enabled
 
   - name: loki
     alias: loki
-    version: ">=6.0.0"
+    version: "7.5.0"
     repository: https://grafana.github.io/helm-charts
     condition: loki.enabled
 
   - name: tempo
     alias: tempo
-    version: ">=1.10.0"
+    version: "1.24.4"
     repository: https://grafana.github.io/helm-charts
     condition: tempo.enabled
 
   - name: jaeger
     alias: jaeger
-    version: ">=4.8.0"
+    version: "4.16.1"
     repository: https://jaegertracing.github.io/helm-charts
     condition: jaeger.enabled
 
   - name: promtail
     alias: promtail
-    version: ">=6.16.0"
+    version: "6.17.1"
     repository: https://grafana.github.io/helm-charts
     condition: promtail.enabled
\ No newline at end of file
diff --git a/INFRA/observability/opentelemtry/crds/telemetryconfig.yaml b/INFRA/observability/opentelemtry/crds/telemetryconfig.yaml
index 249e3f0..ee489bb 100644
--- a/INFRA/observability/opentelemtry/crds/telemetryconfig.yaml
+++ b/INFRA/observability/opentelemtry/crds/telemetryconfig.yaml
@@ -6,8 +6,6 @@ metadata:
 spec:
   group: observability.xsfc.io
   scope: Namespaced
-  metrics:
-      enabled: true
   names:
     plural: telemetryconfigs
     singular: telemetryconfig
diff --git a/INFRA/observability/opentelemtry/templates/datasources.yaml b/INFRA/observability/opentelemtry/templates/datasources.yaml
index 8f5af38..fb846c9 100644
--- a/INFRA/observability/opentelemtry/templates/datasources.yaml
+++ b/INFRA/observability/opentelemtry/templates/datasources.yaml
@@ -52,6 +52,6 @@ data:
         uid: jaeger
         type: jaeger
         access: proxy
-        url: http://{{ .Release.Name }}-jaeger-query.{{ .Release.Namespace }}.svc.cluster.local:16686
+        url: http://{{ .Release.Name }}-jaeger.{{ .Release.Namespace }}.svc.cluster.local:16686
         editable: true
 {{- end }}
\ No newline at end of file
diff --git a/INFRA/observability/opentelemtry/values.yaml b/INFRA/observability/opentelemtry/values.yaml
index 12cfbc4..be144d6 100644
--- a/INFRA/observability/opentelemtry/values.yaml
+++ b/INFRA/observability/opentelemtry/values.yaml
@@ -85,6 +85,9 @@ otelcollector:
           exporters: [debug]
 
 monitoring:
+  enabled: true
+  prometheus:
+    enabled: true
   grafana:
     enabled: true
 
@@ -93,53 +96,12 @@ monitoring:
         enabled: true
         label: grafana_datasource
         labelValue: "1"
+        defaultDatasourceEnabled: false
+        alertmanager:
+          enabled: false
+
+    additionalDataSources: []
 
-    additionalDataSources:
-      - name: Prometheus
-        uid: prometheus
-        type: prometheus
-        access: proxy
-        url: http://observability-monitoring-prometheus.observability.svc.cluster.local:9090
-        isDefault: true
-        editable: true
-
-      - name: Loki
-        uid: loki
-        type: loki
-        access: proxy
-        url: http://observability-loki.observability.svc.cluster.local:3100
-        editable: true
-
-      - name: Tempo
-        uid: tempo
-        type: tempo
-        access: proxy
-        url: http://observability-tempo.observability.svc.cluster.local:3200
-        editable: true
-        jsonData:
-          tracesToLogsV2:
-            datasourceUid: loki
-          tracesToMetrics:
-            datasourceUid: prometheus
-          serviceMap:
-            datasourceUid: prometheus
-
-      - name: Alertmanager
-        uid: alertmanager
-        type: alertmanager
-        access: proxy
-        url: http://observability-monitoring-alertmanager.observability.svc.cluster.local:9093
-        editable: true
-        jsonData:
-          implementation: prometheus
-
-      - name: Jaeger
-        uid: jaeger
-        type: jaeger
-        access: proxy
-        url: http://observability-jaeger-query.observability.svc.cluster.local:16686
-        editable: true
-        
 loki:
     enabled: true
     gateway:
@@ -212,7 +174,9 @@ tempo:
       otlp:
         protocols:
           grpc:
+            endpoint: 0.0.0.0:4317
           http:
+            endpoint: 0.0.0.0:4318
 
   service:
     type: ClusterIP
diff --git a/INFRA/security/kyverno/values.yaml b/INFRA/security/kyverno/values.yaml
index 2762121..1919084 100644
--- a/INFRA/security/kyverno/values.yaml
+++ b/INFRA/security/kyverno/values.yaml
@@ -49,4 +49,7 @@ kyverno:
       enabled: true
 
     policyReports:
-      enabled: true
\ No newline at end of file
+      enabled: true
+
+serviceMonitor:
+  enabled: false
diff --git a/INFRA/security/openbao/templates/init-job.yaml b/INFRA/security/openbao/templates/init-job.yaml
index c103a8e..bdd622f 100644
--- a/INFRA/security/openbao/templates/init-job.yaml
+++ b/INFRA/security/openbao/templates/init-job.yaml
@@ -22,7 +22,7 @@ spec:
         app.kubernetes.io/component: openbao-bootstrap
 
     spec:
-      restartPolicy: OnFailure
+      restartPolicy: Never
       serviceAccountName: {{ .Release.Name }}-bootstrap
 
       containers:
@@ -328,8 +328,7 @@ spec:
 
               echo "Writing generic provisioner policy..."
 
-              kubectl -n "$NAMESPACE" exec -i "$OPENBAO_POD" -- \
-                sh -c "cat > /tmp/${PROVISIONER_POLICY}.hcl" <<POLICY_EOF
+              PROVISIONER_POLICY_DOCUMENT="$(cat <<POLICY_EOF
               # ------------------------------------------------------------
               # Secret-engine management
               # ------------------------------------------------------------
@@ -481,6 +480,15 @@ spec:
                 ]
               }
               POLICY_EOF
+              )"
+
+              kubectl -n "$NAMESPACE" exec "$OPENBAO_POD" -- \
+                sh -ec '
+                  umask 077
+                  test -n "$1"
+                  printf "%s\n" "$1" > "$2"
+                  test -s "$2"
+                ' sh "$PROVISIONER_POLICY_DOCUMENT" "/tmp/${PROVISIONER_POLICY}.hcl"
 
               echo "Installing provisioner policy ${PROVISIONER_POLICY}..."
 
diff --git a/XFSC/Applicationsets/chart/templates/applicationset-template.yaml b/XFSC/Applicationsets/chart/templates/applicationset-template.yaml
index 73762f9..bbd45ac 100644
--- a/XFSC/Applicationsets/chart/templates/applicationset-template.yaml
+++ b/XFSC/Applicationsets/chart/templates/applicationset-template.yaml
@@ -131,4 +131,7 @@ spec:
 
         syncOptions:
           - CreateNamespace=true
-          - ServerSideApply=true
\ No newline at end of file
+          - ServerSideApply=true
+{{- with .Values.esbTemplatePatch }}
+  templatePatch: {{ . | quote }}
+{{- end }}
diff --git a/XFSC/Applicationsets/chart/templates/approject.yaml b/XFSC/Applicationsets/chart/templates/approject.yaml
index 623303e..88fbb39 100644
--- a/XFSC/Applicationsets/chart/templates/approject.yaml
+++ b/XFSC/Applicationsets/chart/templates/approject.yaml
@@ -6,7 +6,7 @@
 
 {{- $existingProject := lookup "argoproj.io/v1alpha1" "AppProject" $projectNamespace .name }}
 
-{{- if not $existingProject }}
+{{- if or (not $existingProject) (and (eq (dig "metadata" "annotations" "meta.helm.sh/release-name" "" $existingProject) $.Release.Name) (eq (dig "metadata" "annotations" "meta.helm.sh/release-namespace" "" $existingProject) $.Release.Namespace)) }}
 
 apiVersion: argoproj.io/v1alpha1
 kind: AppProject
@@ -23,6 +23,7 @@ spec:
 {{ toYaml .sourceRepos | nindent 4 }}
 {{- else }}
     - https://github.com/eclipse-xfsc/deployment.git
+    - https://kubernetes-sigs.github.io/external-dns/
 {{- end }}
 
   destinations:
diff --git a/XFSC/tenant/chart/templates/tenant-registration.yaml b/XFSC/tenant/chart/templates/tenant-registration.yaml
index c8ca809..29f8024 100644
--- a/XFSC/tenant/chart/templates/tenant-registration.yaml
+++ b/XFSC/tenant/chart/templates/tenant-registration.yaml
@@ -63,6 +63,7 @@ spec:
               echo "Issuer: ${BASE_URL}"
 
               curl \
+                --fail-with-body \
                 --show-error \
                 --retry 10 \
                 --retry-delay 3 \
diff --git a/argocd-bootstrap.sh b/argocd-bootstrap.sh
old mode 100644
new mode 100755
index b17b1dc..80eaa0e
--- a/argocd-bootstrap.sh
+++ b/argocd-bootstrap.sh
@@ -5,8 +5,8 @@ set -Eeuo pipefail
 # Config
 # =========================
 readonly NAMESPACE="argocd"
-readonly TIMEOUT="300s"
-readonly ARGO_MANIFEST="https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml"
+readonly TIMEOUT="${ESB_TIMEOUT_SECONDS:-300}s"
+readonly ARGO_MANIFEST="${ESB_ARGO_MANIFEST:?ESB Argo manifest preflight is required}"
 
 # Exit Codes
 readonly EXIT_PREREQ_FAILED=10
@@ -37,87 +37,35 @@ command -v kubectl >/dev/null 2>&1 || {
   exit "$EXIT_PREREQ_FAILED"
 }
 
-kubectl cluster-info >/dev/null 2>&1 || {
-  err "No reachable Kubernetes cluster"
-  exit "$EXIT_PREREQ_FAILED"
-}
-
-# =========================
-# Namespace
-# =========================
-log "Creating namespace: $NAMESPACE"
-kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - \
-  || { err "Failed to create namespace"; exit "$EXIT_NAMESPACE_FAILED"; }
-
-# =========================
-# Install Argo CD
-# =========================
+# Install the pinned manifest through the deployer's API recovery loop.
 log "Installing Argo CD"
-kubectl apply -n "$NAMESPACE" --server-side --force-conflicts -f "$ARGO_MANIFEST" \
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal argo-install \
   || { err "Failed to install Argo CD"; exit "$EXIT_INSTALL_FAILED"; }
 
 # =========================
 # Wait for Rollouts
 # =========================
-components=(
-  "deployment/argocd-server"
-  "deployment/argocd-repo-server"
-  "deployment/argocd-applicationset-controller"
-  "deployment/argocd-notifications-controller"
-  "statefulset/argocd-application-controller"
-)
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal kube-read /apis/apiextensions.k8s.io/v1/customresourcedefinitions/applications.argoproj.io established >/dev/null
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal kube-read /apis/apiextensions.k8s.io/v1/customresourcedefinitions/applicationsets.argoproj.io established >/dev/null
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal kube-read /apis/apiextensions.k8s.io/v1/customresourcedefinitions/appprojects.argoproj.io established >/dev/null
 
-for component in "${components[@]}"; do
-  log "Waiting for $component"
-  kubectl rollout status "$component" -n "$NAMESPACE" --timeout="$TIMEOUT" \
-    || {
-      err "$component failed rollout"
-      kubectl get pods -n "$NAMESPACE" -o wide
-      exit "$EXIT_ROLLOUT_FAILED"
-    }
-done
-
-# =========================
-# Verify Pods Healthy
-# =========================
-log "Verifying all pods are Running/Ready"
-
-not_ready=$(
-  kubectl get pods -n "$NAMESPACE" \
-    --no-headers \
-    | awk '$3 != "Running" && $3 != "Completed" {print}'
-)
-
-if [[ -n "$not_ready" ]]; then
-  err "Some pods are not healthy:"
-  echo "$not_ready"
-  exit "$EXIT_POD_FAILED"
-fi
-
-# =========================
-# Verify Initial Secret Exists
-# =========================
-if ! kubectl get secret argocd-initial-admin-secret -n "$NAMESPACE" >/dev/null 2>&1; then
-  err "Initial admin secret missing"
-  exit "$EXIT_SECRET_FAILED"
-fi
+# One deadline covers all seven workloads. Existing pods may recover after
+# their Deployment has reported a progress deadline during an earlier attempt.
+log "Waiting for Argo CD workloads"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal argo-health || exit "$EXIT_ROLLOUT_FAILED"
 
 # =========================
 # Success
 # =========================
 log "Argo CD installed successfully"
 
-password=$(
-  kubectl -n "$NAMESPACE" get secret argocd-initial-admin-secret \
-    -o jsonpath="{.data.password}" | base64 -d
-)
 
 echo
 echo "=================================="
 echo "ARGO CD READY"
 echo "Namespace: $NAMESPACE"
 echo "Admin User: admin"
-echo "Admin Password: $password"
+echo "Use the configured Argo CD credentials. New installs store the initial password in argocd-initial-admin-secret."
 echo "UI Port-Forward:"
 echo "kubectl port-forward svc/argocd-server -n $NAMESPACE 8080:443"
 echo "=================================="
diff --git a/basic-cluster-init.sh b/basic-cluster-init.sh
old mode 100644
new mode 100755
index e377f06..5262a7a
--- a/basic-cluster-init.sh
+++ b/basic-cluster-init.sh
@@ -1,9 +1,11 @@
 #!/usr/bin/env bash
+set -Eeuo pipefail
+trap 'echo "[ESB_FAILURE] bootstrap stopped at line $LINENO" >&2' ERR
 
 PROFILE=""
 DOMAIN=""
 EMAIL=""
-DNSTOKEN=""
+DNSTOKEN="${ESB_DNS_SECRET_FILE:+provided-through-file}"
 DISABLE_EXTERNAL_DNS=false
 
 usage() {
@@ -44,7 +46,7 @@ while [[ $# -gt 0 ]]; do
   esac
 done
 
-if [[ -z "$PROFILE" || -z "$DOMAIN" || -z "$EMAIL" ]]; then
+if [[ -z "$PROFILE" || -z "$DOMAIN" ]]; then
   usage
   exit 1
 fi
@@ -59,31 +61,43 @@ echo "PROFILE=$PROFILE"
 echo "DOMAIN=$DOMAIN"
 echo "EXTERNAL_DNS_ENABLED=$([[ "$DISABLE_EXTERNAL_DNS" == "true" ]] && echo false || echo true)"
 
-kubectl create namespace observability
-helm repo add otel https://open-telemetry.github.io/opentelemetry-helm-charts
-helm repo add prom https://prometheus-community.github.io/helm-charts
-helm repo add grafana https://grafana.github.io/helm-charts
-helm repo add jaeger https://jaegertracing.github.io/helm-charts
-helm dependency build INFRA/observability/opentelemtry
-helm install -n observability observability INFRA/observability/opentelemtry
-kubectl create namespace security
-helm repo add openbao https://openbao.github.io/openbao-helm
-helm dependency build INFRA/security/openbao
-helm install -n security openbao INFRA/security/openbao
-helm repo add eso https://charts.external-secrets.io
-helm dependency build INFRA/security/eso
-helm install -n security eso INFRA/security/eso
-helm repo add kyverno https://kyverno.github.io/kyverno/
-helm dependency build INFRA/security/kyverno
-helm install -n security kyverno INFRA/security/kyverno
+bash "${ESB_DEPLOY:?}" --internal namespace-create observability
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+echo "[ESB_PHASE] observability"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade observability observability upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n observability observability INFRA/observability/opentelemtry -f "$ESB_OBSERVABILITY_VALUES"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal workload-ready observability deployments app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability
+bash "${ESB_DEPLOY:?}" --internal namespace-create security
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+echo "[ESB_PHASE] openbao"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security openbao upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security openbao INFRA/security/openbao
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal workload-ready security pods '' '["Pod/openbao-0"]'
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+echo "[ESB_PHASE] eso"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security eso upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security eso INFRA/security/eso
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal workload-ready security deployments app.kubernetes.io/instance=eso
+: # Dependencies prepared by ESB chart preflight
+: # Dependencies prepared by ESB chart preflight
+echo "[ESB_PHASE] kyverno"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security kyverno upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security kyverno INFRA/security/kyverno
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal workload-ready security deployments app.kubernetes.io/instance=kyverno
 ./argocd-bootstrap.sh
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal argo-access
 
-helm install -n security infrastructure-namespace INFRA/app-management/app-namespace -f INFRA/app-management/app-namespace-values/infra-values.yaml
+echo "[ESB_PHASE] infrastructure-namespace"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security infrastructure-namespace upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security infrastructure-namespace INFRA/app-management/app-namespace -f INFRA/app-management/app-namespace-values/infra-values.yaml
 
-helm dependency build INFRA/kubernetes-operator
-helm install -n security kubernetes-operator INFRA/kubernetes-operator
+: # Dependencies prepared by ESB chart preflight
+echo "[ESB_PHASE] kubernetes-operator"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security kubernetes-operator upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security kubernetes-operator INFRA/kubernetes-operator
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal workload-ready security deployments app.kubernetes.io/instance=kubernetes-operator
 
-STORAGE_CLASS=$(kubectl get storageclass -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}')
+STORAGE_CLASS="${ESB_STORAGE_CLASS:?ESB selected StorageClass is required}"
 
 NETWORK_ARGS=()
 if [[ "$DISABLE_EXTERNAL_DNS" == "true" ]]; then
@@ -93,16 +107,20 @@ if [[ "$DISABLE_EXTERNAL_DNS" == "true" ]]; then
   NETWORK_ARGS+=(--set-string 'excludes[0]=INFRA/network/bind9')
   NETWORK_ARGS+=(--set-string 'excludes[1]=INFRA/network/external-dns')
 else
-  kubectl create secret generic external-dns \
-    -n infrastructure \
-    --from-literal=token="$DNSTOKEN"
+  bash "${ESB_DEPLOY:?}" --internal apply-file "$ESB_DNS_SECRET_FILE"
 fi
 
 #helm install -n infrastructure basic XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/02_basic-values.yaml --set storageClass="$STORAGE_CLASS"
 #./check-applicationset.sh storage argocd
-helm install -n infrastructure storage XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/03_storage-values.yaml --set storageClass="$STORAGE_CLASS"
+echo "[ESB_PHASE] storage"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal native-compatibility
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade infrastructure storage upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n infrastructure storage XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/03_storage-values.yaml --set storageClass="$STORAGE_CLASS" --set-string tag="${ESB_DEPLOYMENT_REVISION:?Pinned deployment revision is required}" -f "$ESB_STORAGE_VALUES"
 ./check-applicationset.sh storage argocd
-helm install -n infrastructure network XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/04_network-values.yaml --set storageClass="$STORAGE_CLASS" --set profile="$PROFILE" --set domain="$DOMAIN" --set email="$EMAIL" "${NETWORK_ARGS[@]}"
+echo "[ESB_PHASE] network"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade infrastructure network upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n infrastructure network XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/04_network-values.yaml --set storageClass="$STORAGE_CLASS" --set profile="$PROFILE" --set domain="$DOMAIN" --set email="$EMAIL"  --set-string tag="${ESB_DEPLOYMENT_REVISION:?Pinned deployment revision is required}" -f "$ESB_NETWORK_VALUES"
 ./check-applicationset.sh network argocd
-helm install -n infrastructure core XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/05_core-values.yaml --set storageClass="$STORAGE_CLASS"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal gateway policy
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal gateway reconcile
+echo "[ESB_PHASE] core"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade infrastructure core upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n infrastructure core XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/05_core-values.yaml --set storageClass="$STORAGE_CLASS" --set-string tag="${ESB_DEPLOYMENT_REVISION:?Pinned deployment revision is required}" -f "$ESB_CORE_VALUES"
 ./check-applicationset.sh core argocd
diff --git a/check-applicationset.sh b/check-applicationset.sh
old mode 100644
new mode 100755
index c50a51e..f2936e8
--- a/check-applicationset.sh
+++ b/check-applicationset.sh
@@ -8,6 +8,8 @@ TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-600}"
 INTERVAL_SECONDS="${INTERVAL_SECONDS:-10}"
 REFRESH_TYPE="${REFRESH_TYPE:-normal}"
 
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal argo-access
+
 START_TIME="$(date +%s)"
 
 refresh_external_secrets() {
@@ -68,9 +70,8 @@ refresh_external_secrets() {
 
 while true; do
   applications="$(
-    kubectl get applications.argoproj.io \
-      --namespace "$ARGOCD_NAMESPACE" \
-      --output json
+    ESB_READ_TIMEOUT_SECONDS="$(( TIMEOUT_SECONDS - $(date +%s) + START_TIME > 0 ? TIMEOUT_SECONDS - $(date +%s) + START_TIME : 1 ))" bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal kube-read \
+      "/apis/argoproj.io/v1alpha1/namespaces/$ARGOCD_NAMESPACE/applications"
   )"
 
   appset_applications="$(
@@ -91,6 +92,10 @@ while true; do
   )"
 
   count="$(jq 'length' <<< "$appset_applications")"
+  expected="$(jq -er --arg name "$APPSET_NAME" '.[$name]' <<< "${ESB_APPSET_COUNTS:?ESB chart plan is required}")"
+
+  jq -cn --arg appset "$APPSET_NAME" --argjson count "$count" --argjson expected "$expected" \
+    '{type:"application-wait",phase:("waiting-for-"+$appset),applicationCount:$count,expectedCount:$expected}' >&3
 
   if [[ "$count" -eq 0 ]]; then
     echo "Noch keine Applications für ApplicationSet '${APPSET_NAME}' gefunden."
@@ -133,11 +138,15 @@ while true; do
     done <<< "$degraded_synced_applications"
 
     not_ready="$(
-      jq -r '
+      jq -L "${ESB_DEPLOY%/*}/deployment" -r '
+        include "filters";
         .[]
+        | ({name:.metadata.name,sync:.status.sync.status,health:.status.health.status}|accepted_sync_drift) as $accepted
         | select(
-            (.status.sync.status // "Unknown") != "Synced"
+            ((.status.sync.status // "Unknown") != "Synced" and ($accepted|not))
             or (.status.health.status // "Unknown") != "Healthy"
+            or ((.status.operationState.phase // "") == "Running" and ($accepted|not))
+            or ((.spec.source.repoURL // "") == "https://github.com/eclipse-xfsc/deployment.git" and ((.spec.source.targetRevision // "") != env.ESB_DEPLOYMENT_REVISION or (.status.sync.comparedTo.source.targetRevision // "") != env.ESB_DEPLOYMENT_REVISION))
           )
         | [
             .metadata.name,
@@ -150,11 +159,17 @@ while true; do
       ' <<< "$appset_applications"
     )"
 
-    if [[ -z "$not_ready" ]]; then
-      echo "Erfolgreich: Alle ${count} Applications von '${APPSET_NAME}' sind Synced und Healthy."
+    if [[ -z "$not_ready" && "$count" -eq "$expected" ]]; then
+      echo "Ready: ${count} Applications in '${APPSET_NAME}' satisfy health and synchronization policy."
+      jq -L "${ESB_DEPLOY%/*}/deployment" -c '
+        include "filters";
+        {type:"application-readiness",phase:"applications-ready",
+         acceptedSyncDifferences:[.[]|{name:.metadata.name,sync:.status.sync.status,health:.status.health.status}|select(accepted_sync_drift)]}
+      ' <<< "$appset_applications" >&3
       exit 0
     fi
 
+    echo "Applications: ${count}/${expected}; waiting for the complete ApplicationSet."
     echo "Noch nicht bereit:"
     printf '%s\n' "$not_ready"
   fi
diff --git a/ocm-wstack-init.sh b/ocm-wstack-init.sh
old mode 100644
new mode 100755
index bdb9fe1..dbac3eb
--- a/ocm-wstack-init.sh
+++ b/ocm-wstack-init.sh
@@ -1,15 +1,21 @@
 #!/usr/bin/env bash
+set -Eeuo pipefail
+trap 'echo "[ESB_FAILURE] bootstrap stopped at line $LINENO" >&2' ERR
 
 # Forward all bootstrap options (including --disable-external-dns) to the
 # basic cluster initialization.
 ./basic-cluster-init.sh "$@" || exit $?
 
-helm install -n security ocm-wstack-namespace INFRA/app-management/app-namespace -f INFRA/app-management/app-namespace-values/ocm-wstack-values.yaml
+echo "[ESB_PHASE] ocm-wstack-namespace"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade security ocm-wstack-namespace upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n security ocm-wstack-namespace INFRA/app-management/app-namespace -f INFRA/app-management/app-namespace-values/ocm-wstack-values.yaml
 
 # basic-cluster-init.sh runs in a child process, therefore determine the
 # default StorageClass again for the W-Stack ApplicationSet.
-STORAGE_CLASS=$(kubectl get storageclass -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}')
+STORAGE_CLASS="${ESB_STORAGE_CLASS:?ESB selected StorageClass is required}"
 
 # OCM W-Stack
-helm install -n ocm-wstack ocm-wstack XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/06_ocm_wstack-values.yaml --set storageClass="$STORAGE_CLASS"
+echo "[ESB_PHASE] ocm-wstack"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal prerequisites
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal helm-upgrade ocm-wstack ocm-wstack upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" -n ocm-wstack ocm-wstack XFSC/Applicationsets/chart -f XFSC/Applicationsets/values/06_ocm_wstack-values.yaml --set storageClass="$STORAGE_CLASS" --set-string tag="${ESB_DEPLOYMENT_REVISION:?Pinned deployment revision is required}" -f "$ESB_OCM_VALUES"
+bash "${ESB_DEPLOY:?ESB deployment script is required}" --internal startup
 ./check-applicationset.sh ocm-wstack argocd
OCM_UPSTREAM_PATCH
        ;;
    *) printf 'Usage: %s filters|readiness|upstream-patch\n' "$0" >&2; exit 2 ;;
esac
