import base64
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('hot_patch', root/'scripts/hot-patch-runtime.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class PatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name); self.kube = self.work/'uploaded.yaml'; self.kube.write_text('test kubeconfig')
        self.calls = []; self.patch_count = 0
        self.seed = {'metadata': {'name':'ocm-orce-seed','uid':'seed-uid','resourceVersion':'10'}, 'data':{'seed.sh':'old seed'}, 'binaryData':{n:base64.b64encode(b'old').decode() for n in ['runtime.tgz','ui.tgz']}}
        self.deployment = {'metadata':{'name':'ocm-orce','uid':'deployment-uid','resourceVersion':'20'}, 'spec':{'selector':{'matchLabels':{'app':'ocm-orce'}},'template':{'metadata':{'annotations':{'checksum/seed':'previous','checksum/config':'keep-config'}},'spec':{'volumes':[{'name':'seed','configMap':{'name':'ocm-orce-seed'}},{'name':'config','configMap':{'name':'ocm-orce-config'}}], 'initContainers':[{'name':'seed-orce-runtime','command':['/bin/sh','/seed/seed.sh']}]}}}}
        self.host='ocm-osc.facis.cloud'; self.reject_deployment=False

    def command(self,args,**kwargs):
        self.calls.append(args)
        assert args[:4]==['kubectl','--kubeconfig='+str(self.kube),'-n','ocm-wstack']
        assert not any('serviceaccount' in a for a in args)
        if 'exec' in args:
            assert '--request-timeout=45s' in args[:args.index('--')]
            return 'Runtime version: 12.5.11\n'
        if 'get' in args:
            i=args.index('get'); kind,name=args[i+1:i+3]
            return json.dumps(self.deployment if kind=='deployment' else self.seed if name=='ocm-orce-seed' else {'data':{'config.json':json.dumps({'publicOrigin':'https://'+self.host})}})
        if 'patch' in args:
            self.patch_count+=1;i=args.index('patch');resource=args[i+1]
            operations=json.loads(Path(args[args.index('--patch-file')+1]).read_text());self.assertEqual(operations[0]['op'],'test')
            if resource=='deployment' and self.reject_deployment:raise subprocess.CalledProcessError(1,args)
            target=self.seed if resource=='configmap' else self.deployment
            self.assertEqual(operations[0]['value'],target['metadata']['resourceVersion'])
            for op in operations[1:]:
                if op['path']=='/data':target['data']=op['value']
                elif op['path']=='/binaryData':target['binaryData']=op['value']
                elif op['path']=='/spec/template/metadata/annotations':target['spec']['template']['metadata']['annotations']=op['value']
                else:raise AssertionError(op)
            target['metadata']['resourceVersion']=str(int(target['metadata']['resourceVersion'])+1)
            return 'patched\n'
        raise AssertionError(args)

    def invoke(self,*extra):
        argv=['hot-patch','--kubeconfig',str(self.kube),'--backup-dir',str(self.work/'backups'),*extra]
        def rollout(args,**kwargs):
            self.calls.append(args);assert args[:4]==['kubectl','--kubeconfig='+str(self.kube),'-n','ocm-wstack'];return None
        with patch.object(sys,'argv',argv),patch.object(subprocess,'check_output',self.command),patch.object(subprocess,'run',rollout),contextlib.redirect_stdout(io.StringIO()):module.main()

    def test_patch_backup_and_rollback(self):
        old=copy.deepcopy(self.seed);self.invoke();self.assertEqual(self.patch_count,2)
        self.assertEqual(self.deployment['spec']['template']['metadata']['annotations']['checksum/config'],'keep-config')
        backup=next((self.work/'backups').glob('*.json'));self.assertEqual(json.loads(backup.read_text())['seed'],old)
        self.assertEqual(self.kube.read_text(),'test kubeconfig')
        self.invoke('--rollback',str(backup));self.assertEqual(self.seed['data'],old['data']);self.assertEqual(self.seed['binaryData'],old['binaryData'])
        self.assertEqual(self.deployment['spec']['template']['metadata']['annotations']['checksum/seed'],'previous')

    def test_wrong_host_has_no_mutations(self):
        self.host='foreign.example'
        with self.assertRaisesRegex(RuntimeError,'publicOrigin'):self.invoke()
        self.assertEqual(self.patch_count,0)

    def test_conflict_retains_recoverable_backup(self):
        self.reject_deployment=True
        with self.assertRaises(subprocess.CalledProcessError):self.invoke()
        self.assertTrue(list((self.work/'backups').glob('*.json')))
        self.assertEqual(self.deployment['spec']['template']['metadata']['annotations']['checksum/seed'],'previous')

    def test_second_apply_is_read_only(self):
        self.invoke();self.patch_count=0;self.invoke();self.assertEqual(self.patch_count,0)

    def test_rollback_rejects_unrelated_seed_change(self):
        self.invoke();backup=next((self.work/'backups').glob('*.json'));self.seed['data']['seed.sh']='administrator edit';self.patch_count=0
        with self.assertRaisesRegex(RuntimeError,'changed since'):self.invoke('--rollback',str(backup))
        self.assertEqual(self.patch_count,0)


if __name__=='__main__':unittest.main()
