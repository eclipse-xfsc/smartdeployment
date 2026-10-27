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
