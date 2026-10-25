include "contracts";

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
        applications:$applications,gatewayAddresses:$addresses,pendingVolumes:$pending,
        certificateReady:($cert.type=="kubernetes.io/tls" and ($cert.data["tls.crt"]|type)=="string" and ($cert.data["tls.key"]|type)=="string"),
        gatewayConfigurationReady:$gatewayReady,
        gatewayConfiguration:{tenantRouting:{mode:"internal",hostname:$c.tenantHost,clusterIP:$public[0].spec.clusterIP,
            certManagerMapped:$certManagerMapped,runtimeMapped:$runtimeMapped,ready:$routingReady},
            expectedTrafficPolicy:$c.externalTrafficPolicy,proxyTrafficPolicy:$proxyConfig.externalTrafficPolicy,
            foreignAnnotationKeys:($proxyConfig.annotations|foreign_keys),admissionPolicyReady:$policyReady,
            services:[$public[] | {name:.metadata.name,externalTrafficPolicy:.spec.externalTrafficPolicy,
                ports:[.spec.ports[].port],foreignAnnotationKeys:(.metadata.annotations|foreign_keys)}]},
        ocmOperational:$operational,ignoredTerminalPods:$readiness.ignored,failedJobs:$readiness.failedJobs,
        clusterReady:($operational.ready==true and ($present|length)==4 and all($applications[];.sync=="Synced" and .health=="Healthy") and
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
