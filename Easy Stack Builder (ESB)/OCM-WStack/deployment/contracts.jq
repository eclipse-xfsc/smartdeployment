include "values";

def container($name): [.spec.template.spec.containers[]? | select(.name==$name)][0];
def environment($name): container($name).env // [] | map({key:.name,value:.}) | from_entries;
def deployment($name): [.[] | select(.kind=="Deployment" and .metadata.name==$name)][0];
def resource($kind;$name): [.[] | select(.kind==$kind and .metadata.name==$name)][0];

def validate_chart($chart):
    . as $documents |
    if $chart=="INFRA/core/nats" then
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
        (if $name=="policy" then
            $container.image=="node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/tsa/policy:1.0.0" and
            (any($d.spec.template.spec.imagePullSecrets[]?; (.name // "")!="")|not) and
            $e.NATS_ADDR.value=="nats://nats.infrastructure.svc.cluster.local:4222" and
            any($container.ports[]?; .name=="http" and .containerPort==8080) and
            any(($documents|resource("Service";"policy")).spec.ports[]?; .port==8080 and .targetPort==8080)
         elif $name=="didcomm-connector" then
            $e.DIDCOMMCONNECTOR_DATBASE_HOST.value=="cassandra.infrastructure.svc.cluster.local" and
            ($e.DIDCOMMCONNECTOR_DATBASE_PORT.value|tostring)=="9042" and
            $e.DIDCOMMCONNECTOR_DIDCOMM_RESOLVERURL.value=="http://universal-resolver-service.infrastructure.svc.cluster.local:8080" and
            $e.DIDCOMMCONNECTOR_CLOUDFORWARDING_NATS_URL.value=="nats://nats.infrastructure.svc.cluster.local:4222" and
            $e.DIDCOMMCONNECTOR_DATBASE_PASSWORD.valueFrom.secretKeyRef=={name:"esb-credential-verification-cassandra",key:"cassandra-password"} and
            ($e.DIDCOMMCONNECTOR_URL.value|test("^https://[^/]+/api/didcomm$")) and
            (any($documents[]; .kind=="Ingress")|not)
         else
            all($d.spec.template.spec.imagePullSecrets[]?; (.name // "")!="") and
            any($d.spec.template.spec.imagePullSecrets[]?; .name=="esb-ocm-public-registry") and
            $e.CREDENTIALVERIFICATION_SIGNINGKEY.valueFrom.secretKeyRef=={name:"signing",key:"signing-key"} and
            $e.CREDENTIALVERIFICATION_CASSANDRAPASSWORD.valueFrom.secretKeyRef=={name:"esb-credential-verification-cassandra",key:"cassandra-password"} and
            $e.CREDENTIALVERIFICATION_CASSANDRAHOSTS.value=="cassandra.infrastructure.svc.cluster.local" and
            $e.CREDENTIALVERIFICATION_MESSAGING_NATS_URL.value=="nats://nats.infrastructure.svc.cluster.local:4222"
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
     CREDENTIALVERIFICATION_MESSAGING_NATS_URL:"nats://nats.infrastructure.svc.cluster.local:4222"};

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
