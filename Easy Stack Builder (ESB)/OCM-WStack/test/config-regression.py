#!/usr/bin/env python3
"""Build-time configuration regression checks. Requires Python + PyYAML; not a Helm render."""
from pathlib import Path
import copy,json,unittest,yaml
ROOT=Path(__file__).resolve().parents[1]
def read(name):return yaml.safe_load((ROOT/name).read_text())
def merge(base,overlay):
 result=copy.deepcopy(base)
 for key,value in overlay.items():
  if value is None:result.pop(key,None)
  elif isinstance(value,dict) and isinstance(result.get(key),dict):result[key]=merge(result[key],value)
  else:result[key]=copy.deepcopy(value)
 return result
class Configuration(unittest.TestCase):
 def test_storage_crypto_env_overrides_chart_secret_defaults(self):self.check_crypto('Storage Service','storage-service','config','storage')
 def test_signer_crypto_env_overrides_chart_secret_defaults(self):self.check_crypto('signer','signer','signer','signer')
 def check_crypto(self,directory,key,branch,fixture):
  values=merge(read('test/fixtures/'+fixture+'-chart-defaults.yaml'),read(directory+'/values.yaml')[key]);e=values[branch]['engine']
  names=list(e.get('env',{}))+list(e['secretEnv']);self.assertEqual(names.count('VAULT_ADRESS'),1)
  self.assertEqual(e['secretEnv']['VAULT_ADRESS'],{'name':'vault','key':'address'})
  self.assertEqual(e['secretEnv']['VAULT_TOKEN'],{'name':'vault','key':'token'})
  self.assertNotIn('openbao-connection',json.dumps(e))
 def test_only_requested_image_fallbacks(self):
  self.assertEqual(read('Credential Issuance/values.yaml')['issuance-service']['image']['tag'],'v1.4.3')
  self.assertEqual(read('Well Known Chart/values.yaml')['well-known-service']['image']['tag'],'v1.2.1')
  self.assertEqual(read('Credential Retrieval/values.yaml')['credential-retrieval-service']['image']['tag'],'1.1.0')
  self.assertEqual(read('Storage Service/values.yaml')['storage-service']['image']['tag'],'1.2.4')
  self.assertEqual(read('signer/values.yaml')['signer']['image']['tag'],'2.3.4')
 def test_native_ingress_preserved(self):
  baseline=json.loads((ROOT/'docs/native-route-baseline.json').read_text())
  def ingresses(x):
   if not isinstance(x,dict):return []
   out=[]
   for k,v in x.items():
    if k=='ingress' and isinstance(v,dict) and v.get('enabled'):out.append(v)
    else:out+=ingresses(v)
   return out
  for name,expected in baseline.items():self.assertEqual(ingresses(read(name)),expected,name)
 def test_retrieval_signer_topic_matches_signer(self):
  retrieval=read('Credential Retrieval/values.yaml')['credential-retrieval-service']['config']['signerTopic']
  signer=read('signer/values.yaml')['signer']['signer']['nats']['topic'];self.assertEqual(retrieval,signer)
if __name__=='__main__':unittest.main()
