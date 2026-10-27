#!/usr/bin/env bash
# Bounded reads and durable Helm intent records. Kubernetes mutations remain
# conditional on the installation marker and the active deployment lease.

read_capture() {
    local output=$1 limit=$2 budget=$3
    shift 3
    local started=$SECONDS remaining attempt=0 reason delay
    ((budget>0 && limit>0)) || { LAST_STATUS=124; return 124; }
    while ((SECONDS-started < budget && attempt < 30)); do
        remaining=$((budget-(SECONDS-started)))
        attempt=$((attempt+1))
        if run_capture "$output" "$((limit<remaining ? limit : remaining))" "$@"; then return 0; fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        remaining=$((budget-(SECONDS-started)))
        if ! retryable_readiness_reason "$reason" || ((remaining<=0 || attempt==30)); then break; fi
        delay=$((attempt<4 ? 2**attempt : 10))
        ((delay<remaining)) || delay=$remaining
        emit "$(jq -cn --arg command "${1##*/}" --arg reason "$reason" --arg id "${LAST_COMMAND_ID:-}" \
            --argjson attempt "$attempt" --argjson delay "$delay" --argjson remaining "$remaining" \
            '{type:"read-retry",command:$command,commandId:$id,reason:$reason,attempt:$attempt,
              delaySeconds:$delay,remainingSeconds:$remaining,message:("Retrying "+$command+" read: "+$reason)}')"
        sleep "$delay"
    done
    return "${LAST_STATUS:-1}"
}

kube_query() {
    [[ " $* " != *' --raw=/apis/authorization.k8s.io/v1/selfsubjectaccessreviews '* ]] || return 0
    local argument skip=false
    for argument in "$@"; do
        if [[ $skip == true ]]; then skip=false; continue; fi
        case "$argument" in
            -n|--namespace|-l|--selector) skip=true ;;
            -*) ;;
            get|version|auth) return 0 ;;
            *) return 1 ;;
        esac
    done
    return 1
}

# Preserve a generated Secret or marker when create succeeded but its response
# was lost. Never overwrite an existing object with newly generated material.
create_retained() {
    local file=$1 kind name namespace attempt reason
    local directory
    directory=$(mktemp -d "$WORKDIR/retained-create.XXXXXX") || return 1
    kind=$(jq -er '.kind' "$file") || return 1
    name=$(jq -er '.metadata.name' "$file") || return 1
    namespace=$(jq -r '.metadata.namespace // "default"' "$file")
    for attempt in 1 2 3 4 5; do
        get_optional "$directory/existing.json" "$namespace" "$kind" "$name" || return 1
        if jq -e '.!=null' "$directory/existing.json" >/dev/null; then
            if jq -e --slurpfile desired "$file" '
                $desired[0] as $d | . as $existing |
                .kind==$d.kind and .metadata.name==$d.metadata.name and
                (.data // {})==(($d.data // {}) + ($d.stringData // {}|with_entries(.value|=@base64))) and
                (.type // "Opaque")==($d.type // "Opaque") and
                ($d.metadata.labels // {} | to_entries | all(.[]; $existing.metadata.labels[.key]==.value))' \
                "$directory/existing.json" >/dev/null; then return 0; fi
            fail RESOURCE_EXISTS "Existing $namespace/$kind/$name differs from the proposed retained object. Its data is preserved."
            return 1
        fi
        verify_lease || return 1
        if run_capture "$directory/created.json" 30 kubectl create -f "$file" -o json --request-timeout=20s; then return 0; fi
        reason=$(api_failure_reason "$LAST_ERROR" "$LAST_STATUS")
        if ! retryable_api_reason "$reason" && ! grep -qi AlreadyExists "$LAST_ERROR"; then
            command_failure KUBERNETES "Cannot create $namespace/$kind/$name. See output 3."
            return 1
        fi
        sleep 2
    done
    command_failure KUBERNETES "Cannot confirm creation of $namespace/$kind/$name after five attempts. See output 3."
}

command_failure() {
    local code=$1 message=$2
    local reason
    reason=$(api_failure_reason "${LAST_ERROR:-/dev/null}" "${LAST_STATUS:-1}")
    jq -cn --arg code "$code" --arg message "$message" --arg reason "$reason" \
        --arg id "${LAST_COMMAND_ID:-}" --argjson exitCode "${LAST_STATUS:-1}" \
        --arg directory "${ESB_LOG_DIR:-}" \
        '{status:"failed",code:$code,message:$message,diagnostics:{reason:$reason,exitCode:$exitCode,
          commandId:$id,logDirectory:$directory}}' >"$WORKDIR/error.json"
    return 1
}

# Fingerprint content rather than temporary paths. Values and credentials are
# hashed locally; the cluster marker receives only a SHA-256 digest.
helm_intent() {
    node - "$@" <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const hash = crypto.createHash('sha256');
function add(value) { const b=Buffer.from(value); hash.update(String(b.length)+':'); hash.update(b); }
function file(p, relative) {
  const stat=fs.lstatSync(p);
  if (stat.isSymbolicLink()) throw new Error('Helm input must not contain symlinks: '+relative);
  add(relative);
  if (stat.isDirectory()) {
    add('directory');
    for (const name of fs.readdirSync(p).sort()) {
      if (name === '.git') continue;
      file(path.join(p,name),relative+'/'+name);
    }
  } else if (stat.isFile()) {
    add('file');
    const bytes=fs.readFileSync(p);
    // Helm regenerates this timestamp when resolving identical dependencies.
    // Dependency versions, repository URLs and their digest remain hashed.
    add(path.basename(p)==='Chart.lock' ? bytes.toString('utf8').replace(/^generated:.*(?:\r?\n|$)/m,'') : bytes);
  }
  else throw new Error('Unsupported Helm input: '+relative);
}
for (const arg of process.argv.slice(2)) {
  if (fs.existsSync(arg)) file(arg,'input'); else add(arg);
}
console.log(hash.digest('hex'));
JS
}

helm_record_key() {
    printf 'helm-%s' "$(printf '%s/%s' "$1" "$2" | sha256sum | cut -c1-24)"
}

helm_record_read() {
    local namespace=$1 release=$2
    get_optional "$WORKDIR/marker.json" kube-system configmap "$MARKER" || return 1
    marker_matches || { fail OWNERSHIP 'Helm recovery requires this installation marker.'; return 1; }
    jq --arg key "$(helm_record_key "$namespace" "$release")" \
        '(.data[$key] // "null") | fromjson' "$WORKDIR/marker.json"
}

helm_record_write() {
    local namespace=$1 release=$2 digest=$3 state=$4 revision=$5 operation=$6
    local record
    record=$(jq -cn --arg namespace "$namespace" --arg release "$release" --arg digest "$digest" \
        --arg state "$state" --arg operation "$operation" --argjson revision "$revision" \
        --argjson timeoutSeconds "$TIMEOUT_SECONDS" --arg at "$(timestamp)" '{timeoutSeconds:$timeoutSeconds,namespace:$namespace,release:$release,digest:$digest,state:$state,
          revision:$revision,operation:$operation,updatedAt:$at}')
    update_marker "$(jq -cn --arg key "$(helm_record_key "$namespace" "$release")" --arg record "$record" '{($key):$record}')"
}

# Reopen only a pending revision produced by an ESB operation recorded before
# its Helm write. Unknown operations and concurrent changes remain untouched.
helm_recover_recorded() {
    local namespace=$1 release=$2 record=$3 revision=$4
    local operation name backup directory created now budget
    operation=$(jq -r '.operation // empty' "$record")
    jq -e --arg operation "$operation" --argjson revision "$revision" --slurpfile state "$WORKDIR/helm-state.json" '
        .state=="applying" and .revision+1==$revision and
        ($state[0].info.status|IN("pending-install","pending-upgrade"))' "$record" >/dev/null ||
        { fail HELM_PENDING "Helm release $namespace/$release has an unrecorded pending operation; its state is retained."; return 1; }
    name="sh.helm.release.v1.$release.v$revision"
    kube_json "$WORKDIR/pending-secret.json" -n "$namespace" get secret "$name" -o json || return 1
    created=$(jq -er '.metadata.creationTimestamp|fromdateiso8601' "$WORKDIR/pending-secret.json")
    now=$(date +%s)
    budget=$(jq -r --argjson fallback "$TIMEOUT_SECONDS" '(.timeoutSeconds // $fallback)' "$record")
    [[ $budget =~ ^[0-9]+$ && $budget -le 7200 ]] || return 1
    # A process from a previous run can outlive an API interruption. Wait for
    # the entire configured Helm budget plus termination grace before recovery.
    if ((now < created+budget+30)); then
        emit "$(jq -cn --arg release "$release" --argjson remaining "$((created+budget+30-now))" \
            '{type:"helm-recovery-wait",release:$release,remainingSeconds:$remaining}')"
        return 2
    fi
    directory=${ESB_RECOVERY_BACKUP_DIR:-$WORKDIR/recovery-backups}
    mkdir -p "$directory" && chmod 700 "$directory" || return 1
    backup=$(mktemp "$directory/helm-before-recovery.XXXXXX") || return 1
    cp "$WORKDIR/pending-secret.json" "$backup" || return 1
    if ! node - "$WORKDIR/pending-secret.json" "$WORKDIR/pending-patch.json" "$namespace" "$release" "$revision" "$operation" <<'JS'
const fs=require('fs'),zlib=require('zlib');
const [input,output,namespace,name,revision,operation]=process.argv.slice(2);
const secret=JSON.parse(fs.readFileSync(input));
let bytes=Buffer.from(Buffer.from(secret.data.release,'base64').toString(),'base64');
if(bytes[0]===31&&bytes[1]===139) bytes=zlib.gunzipSync(bytes);
const r=JSON.parse(bytes);
if(secret.metadata.name!==`sh.helm.release.v1.${name}.v${revision}`||secret.metadata.namespace!==namespace||
   !/^[a-f0-9]{32}$/.test(operation)||r.name!==name||r.namespace!==namespace||r.version!==Number(revision)||
   !['pending-install','pending-upgrade'].includes(r.info.status)||
   secret.metadata.labels['esb.xfsc.io/operation']!==operation||secret.metadata.labels.owner!=='helm'||
   secret.metadata.labels.name!==name||secret.metadata.labels.status!==r.info.status||
   secret.metadata.labels.version!==revision) throw new Error('Pending Helm record differs from the recorded operation.');
r.info.status='failed';
r.info.description='Interrupted ESB operation '+operation+'; retrying retained release.';
const value=Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(r))).toString('base64')).toString('base64');
fs.writeFileSync(output,JSON.stringify([
 {op:'test',path:'/metadata/resourceVersion',value:secret.metadata.resourceVersion},
 {op:'test',path:'/data/release',value:secret.data.release},
 {op:'replace',path:'/data/release',value},
 {op:'replace',path:'/metadata/labels/status',value:'failed'}]));
JS
    then
        fail HELM_RECOVERY "Pending release $namespace/$release does not match the recorded ESB operation. Its state is retained; see output 3."
        return 1
    fi
    verify_lease || return 1
    if ! run_capture "$WORKDIR/pending-updated.json" 30 kubectl -n "$namespace" patch secret "$name" \
        --type=json --patch-file "$WORKDIR/pending-patch.json" --request-timeout=20s; then
        # The caller reads status again; it never replays a conditional patch.
        transport_failure "$LAST_ERROR" && return 2
        command_failure HELM_RECOVERY "Cannot recover $namespace/$release; see output 3."
        return 1
    fi
    emit "$(jq -cn --arg namespace "$namespace" --arg release "$release" --arg backup "$backup" \
        '{type:"helm-recovery",namespace:$namespace,release:$release,backup:$backup,status:"retrying"}')"
}
