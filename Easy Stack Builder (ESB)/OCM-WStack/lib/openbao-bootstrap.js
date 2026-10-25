'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fail}=require('./config');
const TEMPLATE='INFRA/security/openbao/templates/init-job.yaml';
function transform(text){
 const start='              kubectl -n "$NAMESPACE" exec -i "$OPENBAO_POD" -- \\\n                sh -c "cat > /tmp/${PROVISIONER_POLICY}.hcl" <<POLICY_EOF\n';
 const end='              POLICY_EOF\n';
 if(text.split(start).length!==2||text.split(end).length!==2||text.split('      restartPolicy: OnFailure\n').length!==2)fail('UPSTREAM_CONTRACT','OpenBao bootstrap policy-transfer contract changed. No bootstrap patch was applied.');
 const begin=text.indexOf(start),finish=text.indexOf(end,begin);
 if(finish<begin)fail('UPSTREAM_CONTRACT','OpenBao bootstrap policy delimiter changed.');
 const document=text.slice(begin+start.length,finish);
 // Keep the native, expanded HCL but pass it as one quoted exec argument.
 // stdin streaming can return EOF after creating an empty remote policy file.
 // No token, key material, ACL capability or bootstrap branch is replaced.
 const replacement='              PROVISIONER_POLICY_DOCUMENT="$(cat <<POLICY_EOF\n'+document+end+
 '              )"\n\n'+
 '              kubectl -n "$NAMESPACE" exec "$OPENBAO_POD" -- \\\n'+
 "                sh -ec '\n"+
 '                  umask 077\n'+
 '                  test -n "$1"\n'+
 '                  printf "%s\\n" "$1" > "$2"\n'+
 '                  test -s "$2"\n'+
 "                ' sh \"$PROVISIONER_POLICY_DOCUMENT\" \"/tmp/${PROVISIONER_POLICY}.hcl\"\n";
 return (text.slice(0,begin)+replacement+text.slice(finish+end.length)).replace('      restartPolicy: OnFailure\n','      restartPolicy: Never\n');
}
async function adapt(directory){const file=path.join(directory,TEMPLATE);await fs.writeFile(file,transform(await fs.readFile(file,'utf8')));}
module.exports={TEMPLATE,transform,adapt};
