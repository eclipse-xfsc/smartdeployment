#!/usr/bin/env bash
# Complete missing prerequisites before retrying an interrupted Kyverno bootstrap.

kyverno_read() {
    local output=$1 attempt reason
    shift
    for attempt in 1 2 3 4 5; do
        if run_capture "$output" 30 kubectl "$@" --request-timeout=20s; then
            [[ -s $output ]] || printf 'null\n' >"$output"
            return 0
        fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        retryable_readiness_reason "$reason" || break
        ((attempt < 5)) || break
        sleep "$((attempt*2))"
    done
    record_api_failure kyverno-recovery security kyverno "$attempt" 5 "$reason"
    fail_api_command KYVERNO_RECOVERY "Cannot read Kyverno recovery state: $reason."
}

kyverno_plan() {
    local manifest=$1 directory file kind
    directory=$(mktemp -d "$WORKDIR/kyverno-documents.XXXXXX")
    awk -v directory="$directory" '
        BEGIN { n=0 }
        /^---[[:space:]]*$/ { n++; next }
        { print > (directory "/document-" n ".yaml") }
    ' "$manifest"
    printf '[]\n' >"$WORKDIR/kyverno-plan.json"
    for file in "$directory"/*.yaml; do
        kind=$(sed -n 's/^kind: *//p' "$file")
        case "$kind" in CustomResourceDefinition|ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding) ;; *) continue ;; esac
        # The dry run serializes YAML without requiring Python or an extra npm module.
        run_capture "$WORKDIR/kyverno-object.json" 30 kubectl create --dry-run=client --validate=false -f "$file" -o json ||
            { fail KYVERNO_MANIFEST 'Cannot decode the Kyverno resource manifest.'; return 1; }
        jq -e '
            if .kind=="CustomResourceDefinition" then
                .apiVersion=="apiextensions.k8s.io/v1" and
                (.spec.group=="kyverno.io" or .spec.group=="wgpolicyk8s.io" or (.spec.group|endswith(".kyverno.io")))
            else (.metadata.name|startswith("kyverno")) and
                ((.metadata.namespace // "security")=="security") end
        ' "$WORKDIR/kyverno-object.json" >/dev/null ||
            { fail KYVERNO_MANIFEST 'Recovery manifest contains a resource outside the Kyverno scope.'; return 1; }
        jq --slurpfile object "$WORKDIR/kyverno-object.json" '. + $object' "$WORKDIR/kyverno-plan.json" >"$WORKDIR/kyverno-plan-next.json"
        mv "$WORKDIR/kyverno-plan-next.json" "$WORKDIR/kyverno-plan.json"
    done
    jq -e 'map(.metadata.name) as $names |
        (["clusterpolicies.kyverno.io","policies.kyverno.io","kyverno:background-controller"] - $names | length)==0' \
        "$WORKDIR/kyverno-plan.json" >/dev/null ||
        { fail KYVERNO_MANIFEST 'Required Kyverno CRDs or RBAC are absent from the recovery manifest.'; return 1; }
}

kyverno_complete_prerequisites() {
    local index kind name namespace attempt count
    count=$(jq length "$WORKDIR/kyverno-plan.json")
    for ((index=0; index<count; index++)); do
        jq --argjson index "$index" '.[$index] |
            .metadata.annotations["meta.helm.sh/release-name"]="kyverno" |
            .metadata.annotations["meta.helm.sh/release-namespace"]="security" |
            .metadata.labels["app.kubernetes.io/managed-by"]="Helm"' \
            "$WORKDIR/kyverno-plan.json" >"$WORKDIR/kyverno-create.json"
        kind=$(jq -r .kind "$WORKDIR/kyverno-create.json")
        name=$(jq -r .metadata.name "$WORKDIR/kyverno-create.json")
        namespace=$(jq -r '.metadata.namespace // ""' "$WORKDIR/kyverno-create.json")
        local args=()
        case "$kind" in ServiceAccount|Role|RoleBinding) args=(-n security) ;; esac
        for attempt in 1 2 3 4 5; do
            kyverno_read "$WORKDIR/kyverno-existing.json" "${args[@]}" get "$kind" "$name" --ignore-not-found -o json || return 1
            if jq -e '. != null' "$WORKDIR/kyverno-existing.json" >/dev/null; then break; fi
            verify_lease || return 1
            if run_capture "$WORKDIR/kyverno-created.json" 60 kubectl "${args[@]}" create -f "$WORKDIR/kyverno-create.json" -o json --request-timeout=50s; then
                emit "$(jq -cn --arg kind "$kind" --arg name "$name" '{type:"kyverno-prerequisite",phase:"kyverno",kind:$kind,name:$name,status:"created"}')"
                break
            fi
            # Re-read ambiguous writes before another create; never overwrite objects.
            if ! retryable_api_reason "$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")"; then
                kyverno_read "$WORKDIR/kyverno-existing.json" "${args[@]}" get "$kind" "$name" --ignore-not-found -o json || return 1
                jq -e '. != null' "$WORKDIR/kyverno-existing.json" >/dev/null && break
                fail KYVERNO_PREREQUISITES "Cannot create Kyverno $kind/$name."; return 1
            fi
            ((attempt < 5)) || { fail KYVERNO_PREREQUISITES "Kyverno $kind/$name creation did not recover."; return 1; }
            sleep "$((attempt*2))"
        done
        if [[ $kind == CustomResourceDefinition ]]; then
            wait_resource_condition "crd/$name" Established "$TIMEOUT_SECONDS" || return 1
        fi
    done
}

kyverno_prepare() {
    [[ -f ${SOURCE:?}/INFRA/security/kyverno/Chart.yaml ]] ||
        { fail KYVERNO_CHART 'Pinned Kyverno wrapper chart is unavailable.'; return 1; }
    run_capture "$WORKDIR/kyverno-rendered.yaml" 120 helm template kyverno "$SOURCE/INFRA/security/kyverno" -n security --include-crds ||
        { fail KYVERNO_MANIFEST 'Cannot render pinned Kyverno prerequisites.'; return 1; }
    kyverno_plan "$WORKDIR/kyverno-rendered.yaml" || return 1
    kyverno_complete_prerequisites
}

kyverno_pending_snapshot() {
    kyverno_read "$WORKDIR/kyverno-revisions.json" -n security get secrets -l owner=helm,name=kyverno -o json || return 1
    # Automatic recovery is limited to bootstrap: no deployed/superseded revision.
    jq -e '.items|length>0 and all(.[]; .metadata.labels.status!="deployed" and .metadata.labels.status!="superseded")' \
        "$WORKDIR/kyverno-revisions.json" >/dev/null ||
        { fail HELM_PENDING 'Kyverno has a successful revision; automatic bootstrap recovery does not apply.'; return 1; }
    jq '.items|max_by(.metadata.labels.version|tonumber)' "$WORKDIR/kyverno-revisions.json" >"$WORKDIR/kyverno-pending-secret.json"
    node - "$WORKDIR/kyverno-pending-secret.json" "$WORKDIR/kyverno-release.json" "$WORKDIR/kyverno-stored.yaml" <<'JS'
const fs = require('fs'), zlib = require('zlib');
const secret = JSON.parse(fs.readFileSync(process.argv[2]));
let bytes = Buffer.from(Buffer.from(secret.data.release, 'base64').toString(), 'base64');
if (bytes[0] === 31 && bytes[1] === 139) bytes = zlib.gunzipSync(bytes);
const release = JSON.parse(bytes);
const meta = release.chart.metadata;
if (release.name !== 'kyverno' || release.namespace !== 'security' ||
    !['pending-upgrade','pending-install'].includes(release.info.status) ||
    String(release.version) !== secret.metadata.labels.version ||
    secret.metadata.labels.status !== release.info.status ||
    meta.name !== 'kyverno-wrapper' || meta.appVersion !== '1.15.2' ||
    !meta.dependencies.some(d => d.name === 'kyverno' && d.version === '3.5.2')) process.exit(1);
fs.writeFileSync(process.argv[3], JSON.stringify(release));
fs.writeFileSync(process.argv[4], release.manifest);
JS
}

kyverno_recover_pending() {
    local status=$1 created now remaining name component backup directory started=$SECONDS
    [[ $status == pending-upgrade || $status == pending-install ]] ||
        { fail HELM_PENDING "Kyverno is $status; bootstrap recovery does not apply."; return 1; }
    while true; do
        ((SECONDS-started <= TIMEOUT_SECONDS+60)) || { fail HELM_PENDING 'Kyverno pending-state observation timed out.'; return 1; }
        verify_lease || return 1
        kyverno_pending_snapshot || { fail HELM_PENDING 'Kyverno pending release does not meet bootstrap recovery checks.'; return 1; }
        created=$(jq -r '.metadata.creationTimestamp | fromdateiso8601' "$WORKDIR/kyverno-pending-secret.json")
        now=$(date +%s)
        remaining=$((created+TIMEOUT_SECONDS+30-now))
        ((remaining > 0)) || break
        emit "$(jq -cn --argjson remaining "$remaining" '{type:"helm-recovery-wait",phase:"kyverno",remainingSeconds:$remaining}')"
        sleep "$((remaining<15 ? remaining : 15))"
        if run_capture "$WORKDIR/helm-state.json" 30 helm status kyverno -n security -o json; then
            case $(jq -r .info.status "$WORKDIR/helm-state.json") in
                deployed|failed) jq -r .info.status "$WORKDIR/helm-state.json"; return 0 ;;
            esac
        fi
    done
    directory=${ESB_RECOVERY_BACKUP_DIR:-${TMPDIR:-/tmp}/esb-ocmwstack-recovery}
    if ! mkdir -p "$directory" || ! chmod 700 "$directory"; then
        fail KYVERNO_BACKUP 'Cannot prepare the Kyverno backup directory; release state is unchanged.'
        return 1
    fi
    backup=$(mktemp "$directory/kyverno-before-recovery.XXXXXX") || {
        fail KYVERNO_BACKUP 'Cannot create the Kyverno backup file; release state is unchanged.'
        return 1
    }
    if ! cp "$WORKDIR/kyverno-pending-secret.json" "$backup"; then
        fail KYVERNO_BACKUP 'Cannot save the Kyverno backup; release state is unchanged.'
        return 1
    fi
    emit "$(jq -cn --arg backup "$backup" '{type:"helm-recovery",phase:"kyverno",status:"restoring-prerequisites",backup:$backup}')"
    kyverno_plan "$WORKDIR/kyverno-stored.yaml" || return 1
    kyverno_complete_prerequisites || return 1
    for component in admission background cleanup reports; do
        verify_lease || return 1
        run "$((TIMEOUT_SECONDS+30))" kubectl -n security rollout status "deployment/kyverno-$component-controller" "--timeout=${TIMEOUT_SECONDS}s" || return 1
    done
    verify_lease || return 1
    # Compare the live revision set immediately before the conditional update.
    cp "$WORKDIR/kyverno-pending-secret.json" "$WORKDIR/kyverno-original-secret.json"
    kyverno_pending_snapshot || return 1
    jq -e --slurpfile original "$WORKDIR/kyverno-original-secret.json" \
        '.metadata.resourceVersion==$original[0].metadata.resourceVersion and .data.release==$original[0].data.release' \
        "$WORKDIR/kyverno-pending-secret.json" >/dev/null ||
        { fail HELM_PENDING 'Kyverno release changed during recovery; its state was preserved.'; return 1; }
    node - "$WORKDIR/kyverno-pending-secret.json" "$WORKDIR/kyverno-release.json" "$WORKDIR/kyverno-recovery-patch.json" <<'JS'
const fs = require('fs'), zlib = require('zlib');
const secret = JSON.parse(fs.readFileSync(process.argv[2]));
const release = JSON.parse(fs.readFileSync(process.argv[3]));
release.info.status = 'failed';
release.info.description = 'Interrupted bootstrap recovered; prerequisites restored; retrying Helm upgrade.';
const encoded = Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(release)))).toString('base64');
fs.writeFileSync(process.argv[4], JSON.stringify([
 {op:'test',path:'/metadata/resourceVersion',value:secret.metadata.resourceVersion},
 {op:'test',path:'/data/release',value:secret.data.release},
 {op:'replace',path:'/data/release',value:Buffer.from(encoded).toString('base64')},
 {op:'replace',path:'/metadata/labels/status',value:'failed'}
]));
JS
    name=$(jq -r .metadata.name "$WORKDIR/kyverno-pending-secret.json")
    run 45 kubectl -n security patch secret "$name" --type=json --patch-file "$WORKDIR/kyverno-recovery-patch.json" --request-timeout=30s || return 1
    emit '{"type":"helm-recovery","phase":"kyverno","status":"ready-for-upgrade"}'
    printf 'failed\n'
}
