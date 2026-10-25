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
        runtimeEnabled:true, runtimeImage:(.runtimeImage // ""),
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
    require_that($defaults.routes | type == "array"; "Native tenant routes are missing.") |
    {certificate:{enabled:false,secretName:("esb-"+$c.tenantRelease+"-tls")},
     tenant:{domain:$c.domain,id:$c.tenantId,group:$c.tenantId,subdomain:$c.tenantSubdomain},
     openbao:{transit:{mountPath:("ocm-wstack/"+$c.tenantId)}},
     routes:(($defaults.routes | map(if .name == "didcomm" then .enabled=false else . end)) +
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
